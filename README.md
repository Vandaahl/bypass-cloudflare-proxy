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

### 1. Simple Proxy Request

To proxy a URL and bypass Cloudflare:

```bash
curl "http://localhost:5003/?url=https://example.com/some-page"
```

The proxy will:
1. Contact the Unflare service to get valid clearance data for `example.com`.
2. Make a request to the target URL with those cookies and headers.
3. Return the response, rewriting any internal links to also use the proxy.

### 2. Scraping Clearance Data Directly (Unflare Service)

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

### 3. XML Feed Filtering

To proxy and filter XML/RSS items, use the **XML Processor Service** on port 5004. You can pass the `ignore` parameter (comma-separated list of categories to exclude) and optionally the `direct=true` parameter to bypass the Cloudflare proxy (useful if the target is not protected by Cloudflare):

```bash
# Proxy through bypass-cloudflare-proxy
curl "http://localhost:5004/?url=https://example.com/feed/&ignore=category1,category2"

# Fetch directly (bypassing the proxy)
curl "http://localhost:5004/?url=https://example.com/feed/&ignore=category1&direct=true"
```

The XML Processor will fetch the feed, process it, and return the modified XML.

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
- `ADDON_PORT`: The port the proxy service listens on (default: `5003`).
- `DOMAIN_WHITELIST`: Optional comma-separated list of domains that are allowed to be proxied.
- `PROXY_URL`: The URL of the Addon Proxy (for XML Processor) (default: `http://bypass-cloudflare-proxy:5003`).
- `XML_PROCESSOR_PORT`: The port the XML Processor listens on (default: `5004`).

## Project Structure

- `Dockerfile`: Build instructions for the heavy Unflare service (includes Chromium).
- `Dockerfile.addon`: Build instructions for the lightweight Proxy service.
- `xml-processor/`: Source code and Dockerfile for the XML Processor service.
- `script.js`: The main logic for the Proxy service (URL rewriting, caching, and proxying).
- `src/`: Source code for the TypeScript-based Unflare service.
- `docker-compose.yaml`: Orchestrates both services.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
