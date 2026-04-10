# Bypass Cloudflare Proxy

**AI was used to help create this project**

A triple-service Node.js solution in a Docker container to bypass Cloudflare protection and proxy requests seamlessly. This project consists of three main components:
1. **Unflare Service**: A headless browser-based API that solves Cloudflare challenges and returns clearance cookies and headers.
2. **Addon Proxy (bypass-cloudflare-proxy)**: A lightweight Node.js server that uses the Unflare service to proxy general requests (HTML, CSS, etc.), providing a seamless browsing experience even behind Cloudflare.
3. **XML Processor Service**: A specialized service for handling and modifying XML requests. It uses the Addon Proxy to fetch content and then applies filtering and URL rewriting.

## Features

- **Cloudflare Bypass**: Automatically solves Cloudflare challenges using Puppeteer and `puppeteer-real-browser`.
- **Automatic Header/Cookie Injection**: Proxies requests with the necessary headers and cookies obtained from Unflare.
- **URL Rewriting**: Rewrites links, images, and other resources in HTML/CSS/XML to ensure they also go through the proxy.
- **XML Filtering**: Can filter RSS/XML feeds by category.
- **Efficient Architecture**: Uses a lightweight `node:slim` image for the proxy and XML services, while the heavy browser logic is isolated in the Unflare service.

## Prerequisites

- [Docker](https://www.docker.com/) and [Docker Compose](https://docs.docker.com/compose/) installed.

## Getting Started

To start the services, create a `.env` file (see [Configuration](#configuration) section) and run:

```bash
docker-compose up -d
```

This will launch:
- **Unflare Service** on `http://localhost:5002`
- **Bypass Proxy Service** on `http://localhost:5003`
- **XML Processor Service** on `http://localhost:5004`

## Usage

### 1. Simple Proxy Request (Addon Proxy)

To proxy a URL and bypass Cloudflare, use the **Addon Proxy** on port 5003:

```bash
curl "http://localhost:5003/?url=https://example.com/some-page"
```

The proxy will:
1. Contact the Unflare service to get valid clearance data for `example.com`.
2. Make a request to the target URL with those cookies and headers.
3. Return the response, rewriting any internal links, images, and resources to also use the proxy.

#### Query Parameters for Addon Proxy:

- `url` (Required): The target URL to proxy.
- `remove_classes` (Optional): A comma-separated list of CSS class names. Elements with these classes will be removed from the HTML before it is served.

---

### 2. XML Feed Processing (XML Processor)

To proxy, filter, and enhance XML/RSS feeds, use the **XML Processor Service** on port 5004. This service can automatically fetch images from linked articles and rewrite URLs to point through the proxy.

```bash
# Proxy through bypass-cloudflare-proxy and filter by category
curl "http://localhost:5004/?url=https://example.com/feed/&ignore=category1,category2"

# Fetch directly (bypassing the proxy) and scrape images
curl "http://localhost:5004/?url=https://example.com/feed/&img_selector=article .main-image&direct=true"
```

The XML Processor will fetch the feed, process it, and return the modified XML.

#### Query Parameters for XML Processor:

- `url` (Required): The target XML/RSS feed URL.
- `ignore` (Optional): A comma-separated list of categories to exclude. Items containing any of these categories will be removed from the feed.
- `remove_classes` (Optional): A comma-separated list of CSS class names. These are passed to the proxy when rewriting URLs, ensuring that when you click a link from the feed, the resulting page also has these elements removed.
- `img_selector` (Optional): A CSS selector used to scrape an image from each item's linked page. If found, the image is added as an `<enclosure>` to the feed item.
- `direct` (Optional): Set to `true` to fetch the feed directly from the target URL, bypassing the Cloudflare proxy (useful if the feed itself is not protected).

---

### 3. Scraping Clearance Data Directly (Unflare Service)

If you only need the cookies and headers to use in your own application:

```bash
curl -X POST http://localhost:5002/scrape \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/", "timeout": 60000}'
```

Response format:
```json
{
  "cookies": [ ... ],
  "headers": { ... }
}
```

### Configuration

The proxy configuration is managed via a `.env` file in the project root. You can create one with the following default values:

```env
# Proxy Configuration
UNFLARE_URL=http://unflare:5002
ADDON_PORT=5003
DOMAIN_WHITELIST=

# XML Processor Configuration
PROXY_URL=http://bypass-cloudflare-proxy:5003
XML_PROCESSOR_PORT=5004
```

#### Environment Variables

- `UNFLARE_URL`: The URL of the Unflare service (default: `http://unflare:5002`).
- `ADDON_HOST`: The internal hostname of the Addon Proxy service (default: `localhost` for Podman Pods, `bypass-cloudflare-proxy` in Docker Compose).
- `ADDON_PORT`: The port the proxy service listens on (default: `5003`).
- `DOMAIN_WHITELIST`: Optional comma-separated list of domains that are allowed to be proxied.
- `PROXY_URL`: The internal URL of the Addon Proxy (for XML Processor) (default: `http://bypass-cloudflare-proxy:5003`).
- `PUBLIC_PROXY_URL`: Optional. The public URL of the Addon Proxy. If set, XML link rewriting will use this base. If not set, it is derived from the request host.
#### Note for Podman Pods
If you are running these services in a single **Podman Pod**, they share the same network namespace and should communicate via `localhost`. Ensure `ADDON_HOST` is set to `localhost` in your environment files or Quadlet definitions.

## Project Structure

- `Dockerfile`: Build instructions for the heavy Unflare service (includes Chromium).
- `bypass-cloudflare-proxy/`: Source code and Dockerfile for the lightweight Proxy service.
- `xml-processor/`: Source code and Dockerfile for the XML Processor service.
- `src/`: Source code for the TypeScript-based Unflare service.
- `docker-compose.yaml`: Orchestrates all services.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
