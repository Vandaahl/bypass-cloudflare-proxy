const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

// Configuration
const UNFLARE_URL = process.env.UNFLARE_URL || 'http://localhost:5002';
const PORT = process.env.ADDON_PORT || 5003;

// In-memory cache for clearance cookies and headers
// Key: domain (e.g., 'myduckisdead.org')
// Value: { cookies, headers, expires }
const clearanceCache = new Map();

app.use(cors());

app.get('/', async (req, res) => {
    const targetUrl = req.query.url;
    
    if (!targetUrl) {
        return res.status(400).json({ error: 'Missing "url" query parameter.' });
    }

    let domain;
    try {
        domain = new URL(targetUrl).hostname;
    } catch (e) {
        return res.status(400).json({ error: 'Invalid URL provided.' });
    }

    console.log(`Processing request for: ${targetUrl} (domain: ${domain})`);

    try {
        let clearanceData = clearanceCache.get(domain);
        const now = Date.now() / 1000;

        // Check if we have valid cached clearance data
        if (clearanceData && clearanceData.expires > now + 60) {
            console.log(`Using cached clearance for ${domain}`);
        } else {
            console.log(`Scraping new clearance for: ${targetUrl}`);
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

            // Find the cf_clearance cookie to determine expiration
            const cfClearanceCookie = cookies.find(c => c.name === 'cf_clearance');
            const expires = cfClearanceCookie ? cfClearanceCookie.expires : (Date.now() / 1000 + 3600);

            clearanceData = {
                cookies,
                headers: unflareHeaders,
                expires
            };

            // Cache the clearance data
            clearanceCache.set(domain, clearanceData);
        }

        const { cookies, headers: unflareHeaders } = clearanceData;

        // 2. Prepare cookies for the request
        // Concatenate cookies into a single Cookie header string
        const cookieString = cookies
            .map(cookie => `${cookie.name}=${cookie.value}`)
            .join('; ');

        // 3. Make the request to the target URL using the obtained credentials
        let targetResponse = await axios.get(targetUrl, {
            headers: {
                ...unflareHeaders,
                'Cookie': cookieString,
                // Set Referer to the target URL's origin to bypass hotlinking protection
                'Referer': new URL(targetUrl).origin + '/',
                // Request identity to avoid complex decompression for the raw response if needed
                'accept-encoding': 'identity',
            },
            responseType: 'arraybuffer', // Ensure we get the raw response data
            validateStatus: () => true // Allow any status code to be returned as-is
        });

        // If we get a 403, it might mean our cached clearance is no longer valid
        if (targetResponse.status === 403 && clearanceCache.has(domain)) {
            console.log(`Cached clearance for ${domain} returned 403. Retrying with fresh scrape...`);
            clearanceCache.delete(domain);
            
            // Re-call the logic but force a scrape this time
            // (Simplest way here is to just perform the scrape and request again)
            const retryUnflareResponse = await axios.post(`${UNFLARE_URL}/scrape`, {
                url: targetUrl,
                timeout: 60000
            }, {
                headers: { 'Content-Type': 'application/json' }
            });

            const { cookies: retryCookies, headers: retryHeaders } = retryUnflareResponse.data;
            const cfClearanceCookie = retryCookies.find(c => c.name === 'cf_clearance');
            const expires = cfClearanceCookie ? cfClearanceCookie.expires : (Date.now() / 1000 + 3600);

            const newClearanceData = {
                cookies: retryCookies,
                headers: retryHeaders,
                expires
            };
            clearanceCache.set(domain, newClearanceData);

            const retryCookieString = retryCookies
                .map(cookie => `${cookie.name}=${cookie.value}`)
                .join('; ');

            targetResponse = await axios.get(targetUrl, {
                headers: {
                    ...retryHeaders,
                    'Cookie': retryCookieString,
                    'Referer': new URL(targetUrl).origin + '/',
                    'accept-encoding': 'identity',
                },
                responseType: 'arraybuffer',
                validateStatus: () => true
            });
        }

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

        // Set Referer to match the target site to avoid some hotlinking protections
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        // Handle HTML specifically to rewrite links and resources
        const contentType = targetResponse.headers['content-type'] || '';
        if (contentType.includes('text/html')) {
            let html = targetResponse.data.toString();
            
            // Construct the base URL for the proxy
            const protocol = req.headers['x-forwarded-proto'] || req.protocol;
            const host = req.headers['x-forwarded-host'] || req.get('host');
            const proxyBase = `${protocol}://${host}/?url=`;
            
            // Rewrite all relative and absolute URLs in src/href attributes
            const rewriteUrl = (url) => {
                if (!url || url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('#')) {
                    return url;
                }
                
                let absoluteUrl;
                try {
                    absoluteUrl = new URL(url, targetUrl).href;
                } catch (e) {
                    return url;
                }

                // If the absolute URL's domain is different from the target domain,
                // do not proxy it through Unflare.
                try {
                    const resourceUrl = new URL(absoluteUrl);
                    if (resourceUrl.hostname !== domain) {
                        return absoluteUrl;
                    }
                } catch (e) {
                    return absoluteUrl;
                }
                
                return `${proxyBase}${encodeURIComponent(absoluteUrl)}`;
            };

            // Simple regex-based replacement for attributes containing URLs
            // We also handle common data attributes and srcset
            html = html.replace(/\b(src|href|srcset|style|data-[a-z0-9-]+)=["']([^"']+)["']/gi, (match, attr, value) => {
                const lowerAttr = attr.toLowerCase();
                
                // Only rewrite if it's a known URL attribute or starts with data- and looks like it might be a URL
                const isKnownUrlAttr = ['src', 'href', 'srcset', 'style'].includes(lowerAttr);
                const isDataUrlAttr = lowerAttr.startsWith('data-') && 
                    (value.trim().startsWith('http') || value.trim().startsWith('/') || value.trim().includes('.jpg') || value.trim().includes('.png') || value.trim().includes('.ttf') || value.trim().includes('.tff') || value.trim().includes('.woff') || value.trim().includes('.woff2'));

                if (!isKnownUrlAttr && !isDataUrlAttr) {
                    return match;
                }

                if (lowerAttr === 'srcset' || lowerAttr === 'data-srcset') {
                    // srcset contains multiple URLs with descriptors, e.g. "url1 200w, url2 350w"
                    const parts = value.split(',').map(part => {
                        const trimmed = part.trim();
                        if (!trimmed) return part;
                        
                        // Split by whitespace to separate URL from descriptor
                        const splitPart = trimmed.split(/\s+/);
                        const url = splitPart[0];
                        const descriptor = splitPart.slice(1).join(' ');
                        
                        if (!url) return part;
                        return `${rewriteUrl(url)}${descriptor ? ' ' + descriptor : ''}`;
                    });
                    return `${attr}="${parts.join(', ')}"`;
                }

                if (lowerAttr === 'style') {
                    // style can contain url('...')
                    return `${attr}="${value.replace(/url\(["']?([^"'\)]+)["']?\)/gi, (m, u) => {
                        return `url('${rewriteUrl(u)}')`;
                    })}"`;
                }
                
                return `${attr}="${rewriteUrl(value)}"`;
            });
            
            res.status(targetResponse.status).send(html);
        } else if (contentType.includes('text/css')) {
            let css = targetResponse.data.toString();
            
            // Construct the base URL for the proxy
            const protocol = req.headers['x-forwarded-proto'] || req.protocol;
            const host = req.headers['x-forwarded-host'] || req.get('host');
            const proxyBase = `${protocol}://${host}/?url=`;

            // Rewrite function for CSS URLs
            const rewriteCssUrl = (url) => {
                if (!url || url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('#')) {
                    return url;
                }
                
                let absoluteUrl;
                try {
                    absoluteUrl = new URL(url, targetUrl).href;
                } catch (e) {
                    return url;
                }

                try {
                    const resourceUrl = new URL(absoluteUrl);
                    if (resourceUrl.hostname !== domain) {
                        return absoluteUrl;
                    }
                } catch (e) {
                    return absoluteUrl;
                }
                
                return `${proxyBase}${encodeURIComponent(absoluteUrl)}`;
            };

            // Replace all url(...) in CSS
            css = css.replace(/url\(["']?([^"'\)]+)["']?\)/gi, (match, url) => {
                return `url('${rewriteCssUrl(url)}')`;
            });

            res.status(targetResponse.status).send(css);
        } else {
            // Return the raw response body for non-HTML/CSS content
            res.status(targetResponse.status).send(targetResponse.data);
        }

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
