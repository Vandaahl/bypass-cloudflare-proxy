const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const app = express();

const PORT = parseInt(process.env.PORT) || 5004;
const PROXY_URL = process.env.PROXY_URL || 'http://bypass-cloudflare-proxy:5003';

/**
 * Helper to perform a GET request using Node's http or https module.
 */
function httpGet(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
            }
        };

        client.get(url, options, (res) => {
            // Handle redirects (basic implementation)
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const redirectUrl = new URL(res.headers.location, url).href;
                return httpGet(redirectUrl).then(resolve).catch(reject);
            }

            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    data: data
                });
            });
        }).on('error', (err) => {
            reject(err);
        });
    });
}

/**
 * Helper to check if the content is likely XML.
 */
function isXml(contentType, data) {
    const isXmlContentType = contentType && (
        contentType.includes('xml') || 
        contentType.includes('rss') || 
        contentType.includes('atom')
    );
    
    // Check if the content starts with an XML declaration or a common tag like <rss or <feed
    const content = (data || '').trim().toLowerCase();
    const hasXmlSignature = content.startsWith('<?xml') || 
                             content.startsWith('<rss') || 
                             content.startsWith('<feed') ||
                             content.startsWith('<urlset');
    
    return isXmlContentType || hasXmlSignature;
}

/**
 * Helper to send an XML error response.
 */
function sendXmlError(res, status, error, details) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<error>
    <message>${error}</message>
    <details>${details}</details>
</error>`;
    res.set('Content-Type', 'application/xml');
    res.status(status).send(xml);
}

/**
 * Rewrites a URL to go through the proxy if it belongs to the target domain.
 */
function rewriteUrl(url, targetUrl, domain, proxyBase) {
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
}

/**
 * Rewrites URLs within an XML string (e.g., RSS feed <link> tags).
 */
function rewriteXml(xml, targetUrl, domain, proxyBase) {
    // Rewrite <link>...</link> tags content if they contain URLs
    let rewritten = xml.replace(/<link>([^<]+)<\/link>/gi, (match, url) => {
        const trimmedUrl = url.trim();
        if (!trimmedUrl || !trimmedUrl.startsWith('http')) {
            return match;
        }
        return `<link>${rewriteUrl(trimmedUrl, targetUrl, domain, proxyBase)}</link>`;
    });

    // Also handle other common URL patterns in RSS/XML
    // <url>...</url>
    rewritten = rewritten.replace(/<url>([^<]+)<\/url>/gi, (match, url) => {
        const trimmedUrl = url.trim();
        if (!trimmedUrl || !trimmedUrl.startsWith('http')) {
            return match;
        }
        return `<url>${rewriteUrl(trimmedUrl, targetUrl, domain, proxyBase)}</url>`;
    });

    // <enclosure url="..." ... />
    rewritten = rewritten.replace(/(<enclosure\b[^>]*\burl=["'])([^"']+)(["'][^>]*>)/gi, (match, start, url, end) => {
        return `${start}${rewriteUrl(url, targetUrl, domain, proxyBase)}${end}`;
    });

    return rewritten;
}

/**
 * Filters XML by category
 */
function filterXmlByCategory(xml, ignoreList) {
    if (!ignoreList.length) return xml;

    const normalizedIgnore = ignoreList.map(v => v.toLowerCase());

    return xml.replace(/<item\b[^>]*>[\s\S]*?<\/item>/gi, (itemBlock) => {
        const categories = [...itemBlock.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)]
            .map(match => {
                let value = match[1].trim();

                // Strip CDATA if present
                const cdataMatch = value.match(/^<!\[CDATA\[(.*)\]\]>$/i);
                if (cdataMatch) {
                    value = cdataMatch[1];
                }

                return value.trim().toLowerCase();
            });

        const shouldRemove = categories.some(cat => normalizedIgnore.includes(cat));

        return shouldRemove ? '' : itemBlock;
    });
}

app.use(cors());

app.get('/', async (req, res) => {
    let targetUrl = req.query.url;
    const ignoreParam = req.query.ignore || '';
    const directFetch = req.query.direct === 'true';
    
    if (!targetUrl) {
        return sendXmlError(res, 400, 'Bad Request', 'Missing "url" query parameter.');
    }

    try {
        // 1. Fetch the XML (either directly or from the bypass-cloudflare-proxy)
        const fetchUrl = directFetch 
            ? targetUrl 
            : `${PROXY_URL}/?url=${encodeURIComponent(targetUrl)}`;
        
        console.log(`Fetching XML from: ${fetchUrl} (direct: ${directFetch})`);
        const proxyResponse = await httpGet(fetchUrl);

        const contentType = proxyResponse.headers['content-type'] || '';
        let xml = proxyResponse.data;

    // If the response is actually a 403 or 503, it's likely Cloudflare or some protection
    if (proxyResponse.status >= 400) {
        const errorMsg = proxyResponse.status === 403 || proxyResponse.status === 503 
            ? 'Access Denied (Cloudflare?)' 
            : 'Upstream Error';
        console.warn(`Upstream returned ${proxyResponse.status} for ${targetUrl}.`);
        return sendXmlError(res, proxyResponse.status, errorMsg, `The requested URL returned status ${proxyResponse.status}. ${directFetch ? 'Try removing "direct=true".' : ''}`);
    }

    // Check if the response is actually XML
    if (!isXml(contentType, xml)) {
            console.warn(`Rejected non-XML response for ${targetUrl} (Content-Type: ${contentType})`);
            return sendXmlError(res, 415, 'Unsupported Media Type', `The requested URL did not return XML content (Content-Type: ${contentType}).`);
        }

        let domain;
        try {
            domain = new URL(targetUrl).hostname.toLowerCase();
        } catch (e) {
            return sendXmlError(res, 400, 'Bad Request', 'Invalid URL provided.');
        }

        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.headers['x-forwarded-host'] || req.get('host');
        const proxyBase = `${protocol}://${host}/?url=`;

        // 2. Process the XML
        let processedXml = xml;
        const parsedIgnoreList = ignoreParam ? ignoreParam.split(',').filter(Boolean) : [];

        if (parsedIgnoreList.length > 0) {
            processedXml = filterXmlByCategory(processedXml, parsedIgnoreList);
        }

        processedXml = rewriteXml(processedXml, targetUrl, domain, proxyBase);

        // 3. Return the processed XML
        res.set('Content-Type', 'application/xml');
        res.status(proxyResponse.status).send(processedXml);
    } catch (error) {
        console.error(`Error processing XML for ${targetUrl}:`, error.message);
        const status = error.status || 500;
        const details = error.data ? error.data.toString() : error.message;
        sendXmlError(res, status, error.status ? 'Upstream error' : 'Internal server error', details);
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`XML Processor listening on port ${PORT}`);
});
