const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const cheerio = require('cheerio');
const app = express();

const PORT = parseInt(process.env.PORT) || 5004;
const ADDON_PORT = parseInt(process.env.ADDON_PORT) || 5003;
const PROXY_URL = process.env.PROXY_URL || 'http://bypass-cloudflare-proxy:5003';
// PUBLIC_PROXY_URL: Optional public URL of the Addon Proxy (e.g., https://proxy.example.com)
// If not set, it will be derived from the Host header.
const PUBLIC_PROXY_URL = process.env.PUBLIC_PROXY_URL || '';

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
            res.on('data', (chunk) => {
                data += chunk;
            });
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
function rewriteUrl(url, targetUrl, domain, proxyBase, removeClasses = []) {
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

    let proxiedUrl = `${proxyBase}${encodeURIComponent(absoluteUrl)}`;
    if (removeClasses.length > 0) {
        proxiedUrl += `&remove_classes=${encodeURIComponent(removeClasses.join(','))}`;
    }
    return proxiedUrl;
}

/**
 * Extracts image URL from HTML content based on a selector.
 * Uses Cheerio for reliable HTML parsing.
 */
function extractImageUrl(html, selector) {
    if (!html || !selector) return null;

    const $ = cheerio.load(html);
    const element = $(selector);
    
    if (element.length === 0) return null;

    // If the element itself is an img, return its src
    if (element.is('img')) {
        return element.attr('src');
    }

    // Otherwise, find the first img inside it
    const innerImg = element.find('img').first();
    if (innerImg.length > 0) {
        return innerImg.attr('src');
    }

    return null;
}

/**
 * Scrapes an image from a link and adds it to the item element.
 * item is a Cheerio element representing an <item> or <entry>.
 */
async function addImageToCheerioItem(item, selector, targetUrl, domain, proxyBase, directFetch, removeClasses = []) {
    // Check if it already has an image (enclosure or media:content or img tag)
    if (item.find('enclosure[type^="image/"]').length > 0 ||
        item.find('media\\:content[medium="image"]').length > 0 ||
        item.find('img').length > 0) {
        return;
    }

    // Find the link
    let itemLink = item.find('link').first().text().trim();
    if (!itemLink) {
        // Atom uses <link href="...">
        itemLink = item.find('link').first().attr('href');
    }
    
    if (!itemLink) return;

    // If it's already proxied, extract the original URL
    if (itemLink.startsWith(proxyBase)) {
        try {
            itemLink = decodeURIComponent(itemLink.substring(proxyBase.length));
        } catch (e) {
            console.warn(`Failed to decode proxied URL: ${itemLink}`);
        }
    }
    
    if (!itemLink.startsWith('http')) return;

    try {
        // Fetch the linked page (using proxy if not direct)
        const fetchUrl = directFetch
            ? itemLink
            : `${PROXY_URL}/?url=${encodeURIComponent(itemLink)}`;

        const response = await httpGet(fetchUrl);
        if (response.status !== 200) return;

        let imageUrl = extractImageUrl(response.data, selector);
        if (imageUrl) {
            // Un-proxy if it's already proxied by internal/external proxy
            const internalProxyBase = `${PROXY_URL}/?url=`;
            if (imageUrl.startsWith(internalProxyBase)) {
                imageUrl = decodeURIComponent(imageUrl.substring(internalProxyBase.length));
            } else if (imageUrl.startsWith(proxyBase)) {
                imageUrl = decodeURIComponent(imageUrl.substring(proxyBase.length));
            }

            const absoluteImageUrl = new URL(imageUrl, itemLink).href;
            const proxiedImageUrl = rewriteUrl(absoluteImageUrl, targetUrl, domain, proxyBase);
            
            // Add as enclosure
            item.append(`\n        <enclosure url="${proxiedImageUrl}" length="0" type="image/jpeg" />\n    `);
        }
    } catch (e) {
        console.warn(`Failed to scrape image for ${itemLink}: ${e.message}`);
    }
}

/**
 * Process the XML using Cheerio: filter, rewrite URLs, and scrape images.
 */
async function processXml(xml, targetUrl, domain, proxyBase, options = {}) {
    const { ignoreList = [], imgSelector = '', directFetch = false, removeClasses = [] } = options;
    
    // Load XML with xmlMode: true to preserve tags and casing
    const $ = cheerio.load(xml, { xmlMode: true });

    // 1. Filter items by category
    if (ignoreList.length > 0) {
        const normalizedIgnore = ignoreList.map(v => v.toLowerCase());
        $('item, entry').each((i, el) => {
            const item = $(el);
            const categories = item.find('category').map((j, cat) => {
                let val = $(cat).text().trim().toLowerCase();
                return val;
            }).get();

            const shouldRemove = categories.some(cat => normalizedIgnore.includes(cat));
            if (shouldRemove) {
                item.remove();
            }
        });
    }

    // 3. Scrape images if requested
    if (imgSelector) {
        const items = $('item, entry').toArray();
        const BATCH_SIZE = 5;
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
            const batch = items.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(item => 
                addImageToCheerioItem($(item), imgSelector, targetUrl, domain, proxyBase, directFetch, removeClasses)
            ));
        }
    }

    // 2. Rewrite URLs
    $('link, url, enclosure').each((i, el) => {
        const $el = $(el);
        const tagName = el.tagName.toLowerCase();

        if (tagName === 'enclosure') {
            const url = $el.attr('url');
            if (url) {
                // Image enclosures do not need remove_classes parameter
                $el.attr('url', rewriteUrl(url, targetUrl, domain, proxyBase));
            }
        } else {
            // For <link> and <url>
            let url = $el.text().trim();
            if (url.startsWith('http')) {
                $el.text(rewriteUrl(url, targetUrl, domain, proxyBase, removeClasses));
            }
            // Atom links: <link href="..." />
            const href = $el.attr('href');
            if (href && href.startsWith('http')) {
                $el.attr('href', rewriteUrl(href, targetUrl, domain, proxyBase, removeClasses));
            }
        }
    });

    return $.xml();
}

app.use(cors());

app.get('/', async (req, res) => {
    let targetUrl = req.query.url;
    const ignoreParam = req.query.ignore || '';
    const removeClassesParam = req.query.remove_classes || '';
    const imgSelector = req.query.img_selector || '';
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
        
        let proxyBase;
        if (PUBLIC_PROXY_URL) {
            // Use the explicitly provided public proxy URL
            proxyBase = PUBLIC_PROXY_URL.endsWith('/') ? `${PUBLIC_PROXY_URL}?url=` : `${PUBLIC_PROXY_URL}/?url=`;
        } else {
            // Fallback to deriving it from the current Host header
            const proxyHost = host.replace(`:${PORT}`, `:${ADDON_PORT}`);
            proxyBase = `${protocol}://${proxyHost}/?url=`;
        }

        // 2. Process the XML
        const parsedIgnoreList = ignoreParam ? ignoreParam.split(',').filter(Boolean) : [];
        const parsedRemoveClasses = removeClassesParam ? removeClassesParam.split(',').filter(Boolean) : [];
        const processedXml = await processXml(xml, targetUrl, domain, proxyBase, {
            ignoreList: parsedIgnoreList,
            imgSelector,
            directFetch,
            removeClasses: parsedRemoveClasses
        });

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

if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`XML Processor listening on port ${PORT}`);
    });
}

module.exports = {
    rewriteUrl,
    processXml,
    isXml,
    app
};
