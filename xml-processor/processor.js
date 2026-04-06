const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
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
 * Extracts image URL from HTML content based on a selector.
 * Since we don't have an HTML parser, we use a basic regex approach for ID/class selectors.
 */
function extractImageUrl(html, selector) {
    if (!html || !selector) return null;

    let searchPattern;
    if (selector.startsWith('#')) {
        // Find img element by id
        const id = selector.substring(1);
        searchPattern = new RegExp(`<img[^>]+id=["']${id}["'][^>]*src=["']([^"']+)["']`, 'i');
    } else if (selector.startsWith('.')) {
        // Find img element by class
        const className = selector.substring(1);
        searchPattern = new RegExp(`<img[^>]+class=["'][^"']*${className}[^"']*["'][^>]*src=["']([^"']+)["']`, 'i');
    } else {
        // Treat as tag name (e.g., 'img')
        searchPattern = new RegExp(`<${selector}[^>]*src=["']([^"']+)["']`, 'i');
    }

    const match = html.match(searchPattern);
    if (match) return match[1];

    // Try a more flexible search for img tags that contain the ID/class anywhere
    if (selector.startsWith('#')) {
        const id = selector.substring(1);
        const flexMatch = html.match(new RegExp(`<img[^>]+id=["']${id}["']`, 'i'));
        if (flexMatch) {
            const imgTag = flexMatch[0];
            const srcMatch = imgTag.match(/src=["']([^"']+)["']/i);
            if (srcMatch) return srcMatch[1];
        }
    } else if (selector.startsWith('.')) {
        const className = selector.substring(1);
        const flexMatch = html.match(new RegExp(`<img[^>]+class=["'][^"']*${className}[^"']*["']`, 'i'));
        if (flexMatch) {
            const imgTag = flexMatch[0];
            const srcMatch = imgTag.match(/src=["']([^"']+)["']/i);
            if (srcMatch) return srcMatch[1];
        }
    }

    // If no img match found, try to find a parent element matching the selector
    // and then find the first img inside it.
    let parentContent = null;
    if (selector.startsWith('#')) {
        const id = selector.substring(1);
        // Find any tag with this id and capture its content
        // This is tricky with regex due to nested tags, but we'll try to find the opening tag and some following content
        const parentMatch = html.match(new RegExp(`<([a-z0-9]+)[^>]+id=["']${id}["'][^>]*>([\\s\\S]*?)</\\1>`, 'i'));
        if (parentMatch) {
            parentContent = parentMatch[2];
        }
    } else if (selector.startsWith('.')) {
        const className = selector.substring(1);
        // Find any tag with this class and capture its content
        const parentMatch = html.match(new RegExp(`<([a-z0-9]+)[^>]+class=["'][^"']*${className}[^"']*["'][^>]*>([\\s\\S]*?)</\\1>`, 'i'));
        if (parentMatch) {
            parentContent = parentMatch[2];
        }
    }

    if (parentContent) {
        const innerImgMatch = parentContent.match(/<img[^>]+src=["']([^"']+)["']/i);
        if (innerImgMatch) return innerImgMatch[1];
    }

    return null;
}

/**
 * Scrapes an image from a link and adds it to the item block.
 */
async function addImageToItem(itemBlock, selector, targetUrl, domain, proxyBase, directFetch) {
    // Check if it already has an image (enclosure or media:content or img tag)
    if (/<enclosure\b[^>]*\btype=["']image\/[^"']+["'][^>]*>/i.test(itemBlock) ||
        /<media:content\b[^>]*\bmedium=["']image["'][^>]*>/i.test(itemBlock) ||
        /<img\b[^>]*>/i.test(itemBlock)) {
        return itemBlock;
    }

    // Find the link
    const linkMatch = itemBlock.match(/<link>([^<]+)<\/link>/i);
    if (!linkMatch) return itemBlock;

    let itemLink = linkMatch[1].trim();
    
    // If it's already proxied, extract the original URL
    if (itemLink.startsWith(proxyBase)) {
        try {
            itemLink = decodeURIComponent(itemLink.substring(proxyBase.length));
        } catch (e) {
            console.warn(`Failed to decode proxied URL: ${itemLink}`);
        }
    }
    
    if (!itemLink.startsWith('http')) return itemBlock;

    try {
        // Fetch the linked page (using proxy if not direct)
        const fetchUrl = directFetch
            ? itemLink
            : `${PROXY_URL}/?url=${encodeURIComponent(itemLink)}`;

        console.log(`Scraping image for item: ${itemLink} using selector: ${selector}`);
        const response = await httpGet(fetchUrl);
        if (response.status !== 200) return itemBlock;

        let imageUrl = extractImageUrl(response.data, selector);
        if (imageUrl) {
            // Fix for bug 1: If the image URL is already proxied by the internal proxy, un-proxy it first
            // to avoid internal Docker hostnames leaking into the XML.
            const internalProxyBase = `${PROXY_URL}/?url=`;
            if (imageUrl.startsWith(internalProxyBase)) {
                try {
                    imageUrl = decodeURIComponent(imageUrl.substring(internalProxyBase.length));
                } catch (e) {
                    console.warn(`Failed to decode internal proxied image URL: ${imageUrl}`);
                }
            } else if (imageUrl.startsWith(proxyBase)) {
                try {
                    imageUrl = decodeURIComponent(imageUrl.substring(proxyBase.length));
                } catch (e) {
                    console.warn(`Failed to decode proxied image URL: ${imageUrl}`);
                }
            }

            const absoluteImageUrl = new URL(imageUrl, itemLink).href;
            const proxiedImageUrl = rewriteUrl(absoluteImageUrl, targetUrl, domain, proxyBase);
            
            // Add as enclosure
            const enclosure = `\n        <enclosure url="${proxiedImageUrl}" length="0" type="image/jpeg" />`;
            // Insert enclosure before </item>
            return itemBlock.replace(/<\/item>/i, `${enclosure}\n    </item>`);
        }
    } catch (e) {
        console.warn(`Failed to scrape image for ${itemLink}: ${e.message}`);
    }

    return itemBlock;
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
            // Fix for bug 2: Use ADDON_PORT instead of the current PORT for rewritten links
            const proxyHost = host.replace(`:${PORT}`, `:${ADDON_PORT}`);
            proxyBase = `${protocol}://${proxyHost}/?url=`;
        }

        // 2. Process the XML
        let processedXml = xml;
        const parsedIgnoreList = ignoreParam ? ignoreParam.split(',').filter(Boolean) : [];

        if (parsedIgnoreList.length > 0) {
            processedXml = filterXmlByCategory(processedXml, parsedIgnoreList);
        }

        processedXml = rewriteXml(processedXml, targetUrl, domain, proxyBase);
        
        // 2.5. Scrape images for items if imgSelector is provided
        if (imgSelector) {
            const regex = /<item\b[^>]*>[\s\S]*?<\/item>/gi;
            const itemMatches = [...processedXml.matchAll(regex)];
            
            if (itemMatches.length > 0) {
                // Collect all new item contents
                const newItemContents = [];
                const BATCH_SIZE = 5;
                for (let i = 0; i < itemMatches.length; i += BATCH_SIZE) {
                    const batch = itemMatches.slice(i, i + BATCH_SIZE);
                    const results = await Promise.all(batch.map(m => 
                        addImageToItem(m[0], imgSelector, targetUrl, domain, proxyBase, directFetch)
                    ));
                    newItemContents.push(...results);
                }
                
                // Rebuild XML using matches' positions
                let resultXml = '';
                let offset = 0;
                for (let i = 0; i < itemMatches.length; i++) {
                    const match = itemMatches[i];
                    const start = match.index;
                    const end = start + match[0].length;
                    
                    resultXml += processedXml.substring(offset, start) + newItemContents[i];
                    offset = end;
                }
                resultXml += processedXml.substring(offset);
                processedXml = resultXml;
            }
        }

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
