const express = require('express');
const axios = require('axios');
const app = express();

// Configuration
const UNFLARE_URL = process.env.UNFLARE_URL || 'http://localhost:5002';
const PORT = process.env.ADDON_PORT || 5003;

app.get('/', async (req, res) => {
    const targetUrl = req.query.url;
    
    if (!targetUrl) {
        return res.status(400).json({ error: 'Missing "url" query parameter.' });
    }

    console.log(`Scraping clearance for: ${targetUrl}`);

    try {
        // 1. Get clearance cookies and headers from Unflare
        // Making an internal request to Unflare's /scrape endpoint
        const unflareResponse = await axios.post(`${UNFLARE_URL}/scrape`, {
            url: targetUrl,
            timeout: 60000
        }, {
            headers: { 'Content-Type': 'application/json' }
        });

        const { cookies, headers: unflareHeaders } = unflareResponse.data;

        if (!cookies || !unflareHeaders) {
            throw new Error('Failed to obtain cookies or headers from Unflare.');
        }

        // 2. Prepare cookies for the request
        // Concatenate cookies into a single Cookie header string
        const cookieString = cookies
            .map(cookie => `${cookie.name}=${cookie.value}`)
            .join('; ');

        console.log(`Successfully obtained clearance. Fetching raw content from ${targetUrl}...`);

        // 3. Make the request to the target URL using the obtained credentials
        const targetResponse = await axios.get(targetUrl, {
            headers: {
                ...unflareHeaders,
                'Cookie': cookieString,
                // Request identity to avoid complex decompression for the raw response if needed
                'accept-encoding': 'identity',
            },
            responseType: 'arraybuffer', // Ensure we get the raw response data
            validateStatus: () => true // Allow any status code to be returned as-is
        });

        // 4. Forward the response back to the client
        // Forward relevant headers from the target response
        const headersToForward = [
            'content-type',
            'cache-control',
            'last-modified',
            'etag'
        ];

        headersToForward.forEach(header => {
            if (targetResponse.headers[header]) {
                res.set(header, targetResponse.headers[header]);
            }
        });

        // Return the raw response body
        res.status(targetResponse.status).send(targetResponse.data);

    } catch (error) {
        console.error(`Error processing request for ${targetUrl}:`, error.message);
        
        if (error.response) {
            // Either Unflare or the target site returned an error
            res.status(error.response.status).json({
                error: 'Upstream error',
                details: error.response.data.toString()
            });
        } else {
            res.status(500).json({
                error: 'Internal server error',
                message: error.message
            });
        }
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Unflare Add-on Script listening on port ${PORT}`);
    console.log(`Using Unflare service at ${UNFLARE_URL}`);
});
