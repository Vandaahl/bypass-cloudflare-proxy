const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

// Configuration
const UNFLARE_URL = process.env.UNFLARE_URL || 'http://localhost:5002';
const PORT = process.env.ADDON_PORT || 5003;

// In-memory cache for clearance cookies and headers
// Key: domain (e.g., 'example.com')
// Value: { cookies, headers, expires }
const clearanceCache = new Map();

/**
 * Get clearance cookies and headers from Unflare or cache.
 * @param {string} targetUrl The URL to scrape or use for domain lookup.
 * @param {string} domain The domain of the target URL.
 * @param {boolean} forceRefresh If true, skip cache and perform a new scrape.
 * @returns {Promise<{cookies: Array, headers: Object, expires: number}>}
 */
async function getClearanceData(targetUrl, domain, forceRefresh = false) {
    const now = Date.now() / 1000;
    let clearanceData = clearanceCache.get(domain);

    // Check if we have valid cached clearance data
    if (!forceRefresh && clearanceData && clearanceData.expires > now + 60) {
        console.log(`Using cached clearance for ${domain}`);
        return clearanceData;
    }

    console.log(`${forceRefresh ? 'Forcing refresh of' : 'Scraping new'} clearance for: ${targetUrl}`);
    
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
    return clearanceData;
}

/**
 * Rewrites a URL to go through the proxy if it belongs to the target domain.
 * @param {string} url The URL to rewrite (relative or absolute).
 * @param {string} targetUrl The current page's URL (for base resolution).
 * @param {string} domain The current page's domain.
 * @param {string} proxyBase The base URL of this proxy server.
 * @returns {string} The rewritten URL.
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
}

/**
 * Rewrites URLs and resources within an HTML string.
 * @param {string} html The raw HTML content.
 * @param {string} targetUrl The current page's URL.
 * @param {string} domain The current page's domain.
 * @param {string} proxyBase The base URL of this proxy server.
 * @returns {string} The rewritten HTML.
 */
function rewriteHtml(html, targetUrl, domain, proxyBase) {
    return html.replace(/\b(src|href|srcset|style|data-[a-z0-9-]+)=["']([^"']+)["']/gi, (match, attr, value) => {
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
                
                const splitPart = trimmed.split(/\s+/);
                const url = splitPart[0];
                const descriptor = splitPart.slice(1).join(' ');
                
                if (!url) return part;
                return `${rewriteUrl(url, targetUrl, domain, proxyBase)}${descriptor ? ' ' + descriptor : ''}`;
            });
            return `${attr}="${parts.join(', ')}"`;
        }

        if (lowerAttr === 'style') {
            // style can contain url('...')
            return `${attr}="${value.replace(/url\(["']?([^"'\)]+)["']?\)/gi, (m, u) => {
                return `url('${rewriteUrl(u, targetUrl, domain, proxyBase)}')`;
            })}"`;
        }
        
        return `${attr}="${rewriteUrl(value, targetUrl, domain, proxyBase)}"`;
    });
}

/**
 * Rewrites URLs within a CSS string.
 * @param {string} css The raw CSS content.
 * @param {string} targetUrl The current page's URL.
 * @param {string} domain The current page's domain.
 * @param {string} proxyBase The base URL of this proxy server.
 * @returns {string} The rewritten CSS.
 */
function rewriteCss(css, targetUrl, domain, proxyBase) {
    return css.replace(/url\(["']?([^"'\)]+)["']?\)/gi, (match, url) => {
        return `url('${rewriteUrl(url, targetUrl, domain, proxyBase)}')`;
    });
}

/**
 * Performs a proxied GET request to the target URL using the given clearance data.
 * @param {string} targetUrl The URL to request.
 * @param {Object} clearanceData The cookies and headers from Unflare.
 * @returns {Promise<import('axios').AxiosResponse>}
 */
async function performProxiedRequest(targetUrl, clearanceData) {
    const { cookies, headers: unflareHeaders } = clearanceData;
    const cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

    return axios.get(targetUrl, {
        headers: {
            ...unflareHeaders,
            'Cookie': cookieString,
            'Referer': new URL(targetUrl).origin + '/',
            'accept-encoding': 'identity',
        },
        responseType: 'arraybuffer',
        validateStatus: () => true
    });
}

/**
 * Filters XML by category
 *
 * @param xml
 * @param ignoreList
 * @returns {string}
 */
function filterXmlByCategory(xml, ignoreList) {
    if (!ignoreList.length) return xml;

    const normalizedIgnore = ignoreList.map(v => v.toLowerCase());
    console.log(`XML detected. Filtering XML by categories: ${ignoreList.join(', ')}`);

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

/**
 * Handles GET requests to the root route. Pass a 'url' parameter that needs to be proxied.
 * For XML requests, you can pass an 'ignore' parameter with a comma-separated list of categories to ignore.
 */
app.get('/', async (req, res) => {
    const targetUrl = req.query.url;
    
    if (!targetUrl) {
        return res.status(400).json({ error: 'Missing "url" query parameter.' });
    }

    const ignoreParam = req.query.ignore || '';
    const ignoreList = ignoreParam
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    let domain;
    try {
        domain = new URL(targetUrl).hostname;
    } catch (e) {
        return res.status(400).json({ error: 'Invalid URL provided.' });
    }

    console.log(`Processing request for: ${targetUrl} (domain: ${domain})`);

    try {
        // 1. Get clearance data
        let clearanceData = await getClearanceData(targetUrl, domain);

        // 2. Make the request to the target URL
        let targetResponse = await performProxiedRequest(targetUrl, clearanceData);

        // If we get a 403, it might mean our cached clearance is no longer valid
        if (targetResponse.status === 403) {
            console.log(`Target returned 403 for ${domain}. Refreshing clearance and retrying...`);
            clearanceData = await getClearanceData(targetUrl, domain, true);
            targetResponse = await performProxiedRequest(targetUrl, clearanceData);
        }

        // 3. Forward the response back to the client
        const headersToForward = ['content-type', 'cache-control', 'last-modified', 'etag'];
        headersToForward.forEach(header => {
            if (targetResponse.headers[header]) {
                res.set(header, targetResponse.headers[header]);
            }
        });

        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        const contentType = targetResponse.headers['content-type'] || '';
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.headers['x-forwarded-host'] || req.get('host');
        const proxyBase = `${protocol}://${host}/?url=`;

        if (contentType.includes('text/html')) {
            const html = rewriteHtml(targetResponse.data.toString(), targetUrl, domain, proxyBase);
            res.status(targetResponse.status).send(html);
        } else if (contentType.includes('text/css')) {
            const css = rewriteCss(targetResponse.data.toString(), targetUrl, domain, proxyBase);
            res.status(targetResponse.status).send(css);
        } else if (contentType.includes('xml') || contentType.includes('application/rss+xml') || contentType.includes('application/xml')) {
            let xml = targetResponse.data.toString();

            if (ignoreList.length > 0) {
                xml = filterXmlByCategory(xml, ignoreList);
            }

            res.status(targetResponse.status).send(xml);
        } else {
            res.status(targetResponse.status).send(targetResponse.data);
        }

    } catch (error) {
        console.error(`Error processing request for ${targetUrl}:`, error.message);
        const status = error.response ? error.response.status : 500;
        const details = error.response ? error.response.data.toString() : error.message;
        res.status(status).json({
            error: error.response ? 'Upstream error' : 'Internal server error',
            details
        });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Unflare Add-on Script listening on port ${PORT}`);
    console.log(`Using Unflare service at ${UNFLARE_URL}`);
});
