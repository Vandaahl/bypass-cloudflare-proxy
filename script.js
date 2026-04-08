const express = require('express');
const axios = require('axios');
const cors = require('cors');
const cheerio = require('cheerio');
const app = express();

// Configuration
const UNFLARE_URL = process.env.UNFLARE_URL || 'http://localhost:5002';
const PORT = parseInt(process.env.ADDON_PORT) || 5003;
const DOMAIN_WHITELIST = process.env.DOMAIN_WHITELIST
    ? process.env.DOMAIN_WHITELIST.split(',').map(d => d.trim().toLowerCase()).filter(Boolean)
    : [];

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

    const unflareResponse = await axios.post(`${UNFLARE_URL}/scrape`, {
        url: targetUrl,
        timeout: 60000
    }, {
        headers: {'Content-Type': 'application/json'}
    });

    const {cookies, headers: unflareHeaders} = unflareResponse.data;

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
 * Processes HTML using Cheerio to perform two main tasks:
 * 1. Remove elements based on user-defined class names.
 * 2. Rewrite URLs (src, href, srcset, style, etc.) to point through this proxy.
 *
 * This function ensures that the proxied page remains functional and that its resources
 * are also fetched through the Cloudflare bypass.
 *
 * @param {string} html The raw HTML content from the target site.
 * @param {string[]} removeClasses Array of class names to remove from the DOM.
 * @param {string} targetUrl The original URL of the page (for relative URL resolution).
 * @param {string} domain The hostname of the target site (to restrict proxying to the same domain).
 * @param {string} proxyBase The base URL of this proxy server (e.g., http://localhost:5003/?url=).
 * @returns {string} The modified HTML.
 */
function processHtml(html, removeClasses, targetUrl, domain, proxyBase) {
    try {
        // Load HTML into Cheerio for DOM manipulation
        const $ = cheerio.load(html);

        // 1. Element Removal Logic
        // Removes any elements that have classes specified in the 'remove_classes' query parameter.
        if (removeClasses && removeClasses.length > 0) {
            removeClasses.forEach(className => {
                $(`.${className}`).remove();
            });
        }

        // 2. URL Rewriting Logic
        // List of standard attributes that typically contain URLs to resources.
        const urlAttributes = ['src', 'href', 'srcset', 'imagesrcset', 'style', 'poster'];
        
        $('*').each((i, el) => {
            const $el = $(el);

            // Handle <base href="..."> tags specifically.
            // If present, it changes how all relative URLs in the document are resolved.
            if (el.name === 'base' && $el.attr('href')) {
                const originalBase = $el.attr('href');
                $el.attr('href', rewriteUrl(originalBase, targetUrl, domain, proxyBase));
            }

            /**
             * Internal helper to process an attribute value based on its type.
             * @param {string} name Attribute name (e.g., 'src', 'srcset', 'style').
             * @param {string} value The current value of the attribute.
             * @returns {string} The rewritten value.
             */
            const processAttrValue = (name, value) => {
                // Check if the attribute is a 'srcset' variant (standard or data-attribute).
                const isSrcset = name === 'srcset' || name === 'imagesrcset' || name.includes('srcset');
                
                if (isSrcset) {
                    // srcset contains a comma-separated list of "URL Descriptor" pairs.
                    // Example: "image-200.jpg 200w, image-400.jpg 400w"
                    return value.split(',').map(part => {
                        const trimmed = part.trim();
                        if (!trimmed) return part;
                        
                        // Regex to separate the URL from its descriptor (like '200w' or '2x').
                        // ^(\S+) matches the URL (non-whitespace characters).
                        // \s*(.*)$ matches the optional descriptor following it.
                        const match = trimmed.match(/^(\S+)\s*(.*)$/);
                        if (!match) return part;
                        
                        const url = match[1];
                        const descriptor = match[2];
                        
                        // Rewrite only the URL part and re-attach the descriptor.
                        return `${rewriteUrl(url, targetUrl, domain, proxyBase)}${descriptor ? ' ' + descriptor : ''}`;
                    }).join(', ');
                } else if (name === 'style') {
                    // Handle inline CSS in 'style' attributes.
                    // We look for 'url(...)' declarations and rewrite the enclosed URLs.
                    return value.replace(/url\(["']?([^"'\)]+)["']?\)/gi, (m, u) => {
                        return `url('${rewriteUrl(u, targetUrl, domain, proxyBase)}')`;
                    });
                } else {
                    // For standard URL attributes (src, href, poster, etc.), rewrite directly.
                    return rewriteUrl(value, targetUrl, domain, proxyBase);
                }
            };

            // Process the predefined list of URL attributes.
            urlAttributes.forEach(attr => {
                const value = $el.attr(attr);
                if (value) {
                    $el.attr(attr, processAttrValue(attr, value));
                }
            });

            // 3. Data-Attribute Handling
            // Many modern sites use 'data-src', 'data-lazy-src', etc., for lazy-loading.
            // We iterate over all attributes and attempt to identify and rewrite URLs in 'data-' attributes.
            for (const [attrName, value] of Object.entries(el.attribs)) {
                if (attrName.startsWith('data-')) {
                    const lowerValue = value.trim().toLowerCase();
                    
                    // Heuristic to detect if a data-attribute value looks like a URL or an image path.
                    const looksLikeUrl = lowerValue.startsWith('http') ||
                        lowerValue.startsWith('/') ||
                        /\.(jpg|jpeg|png|gif|svg|webp|ttf|woff2?|otf|eot)(\?.*)?$/.test(lowerValue);

                    if (looksLikeUrl) {
                        $el.attr(attrName, processAttrValue(attrName, value));
                    }
                }
            }
        });

        // Return the modified HTML as a string.
        return $.html();
    } catch (e) {
        // Fallback to original HTML if something goes wrong during parsing.
        console.warn('Error processing HTML with Cheerio:', e.message);
        return html;
    }
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
    const {cookies, headers: unflareHeaders} = clearanceData;
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

app.use(cors());

/**
 * Handles GET requests to the root route. Pass a 'url' parameter that needs to be proxied.
 * For XML requests, you can pass an 'ignore' parameter with a comma-separated list of categories to ignore.
 */
app.get('/', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).json({error: 'Missing "url" query parameter.'});
    }

    const ignoreParam = req.query.ignore || '';
    const ignoreList = ignoreParam
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    const removeClassesParam = req.query.remove_classes || '';
    const removeClassesList = removeClassesParam
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    let domain;
    try {
        domain = new URL(targetUrl).hostname.toLowerCase();
    } catch (e) {
        return res.status(400).json({error: 'Invalid URL provided.'});
    }

    // Domain whitelist check
    if (DOMAIN_WHITELIST.length > 0 && !DOMAIN_WHITELIST.includes(domain)) {
        console.warn(`Blocked request to non-whitelisted domain: ${domain}`);
        return res.status(403).json({
            error: 'Forbidden',
            details: `The domain "${domain}" is not on the allowed whitelist.`
        });
    }

    console.log(`Processing request for: ${targetUrl} (domain: ${domain})`);

    try {
        // Get clearance data
        let clearanceData = await getClearanceData(targetUrl, domain);

        // Make the request to the target URL
        let targetResponse = await performProxiedRequest(targetUrl, clearanceData);

        // If we get a 403, it might mean our cached clearance is no longer valid
        if (targetResponse.status === 403) {
            console.log(`Target returned 403 for ${domain}. Refreshing clearance and retrying...`);
            clearanceData = await getClearanceData(targetUrl, domain, true);
            targetResponse = await performProxiedRequest(targetUrl, clearanceData);
        }

        // Forward the response back to the client
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
            const html = processHtml(targetResponse.data.toString(), removeClassesList, targetUrl, domain, proxyBase);
            res.status(targetResponse.status).send(html);
        } else if (contentType.includes('text/css')) {
            const css = rewriteCss(targetResponse.data.toString(), targetUrl, domain, proxyBase);
            res.status(targetResponse.status).send(css);
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
