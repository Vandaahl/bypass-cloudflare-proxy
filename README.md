# Bypass Cloudflare Proxy

**AI was used to help create this project**

A dual-service Node.js solution to bypass Cloudflare protection and proxy requests seamlessly. This project consists of two main components:
1. **Unflare Service**: A headless browser-based API that solves Cloudflare challenges and returns clearance cookies and headers.
2. **Addon Proxy (bypass-cloudflare-proxy)**: A lightweight Node.js server that uses the Unflare service to proxy GET requests, providing a seamless browsing experience even behind Cloudflare.

## Features

- **Cloudflare Bypass**: Automatically solves Cloudflare challenges using Puppeteer and `puppeteer-real-browser`.
- **Automatic Header/Cookie Injection**: Proxies requests with the necessary headers and cookies obtained from Unflare.
- **URL Rewriting**: Rewrites links, images, and other resources in HTML/CSS to ensure they also go through the proxy.
- **XML Filtering**: Can filter RSS/XML feeds by category.
- **Efficient Architecture**: Uses a lightweight `node:slim` image for the proxy service, while the heavy browser logic is isolated in the Unflare service.

## Prerequisites

- [Docker](https://www.docker.com/) and [Docker Compose](https://docs.docker.com/compose/) installed.

## Getting Started

To start the services, simply run:

```bash
docker-compose up -d
```

This will launch:
- **Unflare Service** on `http://localhost:5002`
- **Bypass Proxy Service** on `http://localhost:5003`

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

You can filter XML/RSS items by category by passing the `ignore` parameter (comma-separated list of categories to exclude):

```bash
curl "http://localhost:5003/?url=https://example.com/feed/&ignore=category1,category2"
```

## Configuration

### Environment Variables (for `bypass-cloudflare-proxy` service)

- `UNFLARE_URL`: The URL of the Unflare service (default: `http://unflare:5002`).
- `ADDON_PORT`: The port the proxy service listens on (default: `5003`).

## Project Structure

- `Dockerfile`: Build instructions for the heavy Unflare service (includes Chromium).
- `Dockerfile.addon`: Build instructions for the lightweight Proxy service.
- `script.js`: The main logic for the Proxy service (URL rewriting, caching, and proxying).
- `src/`: Source code for the TypeScript-based Unflare service.
- `docker-compose.yaml`: Orchestrates both services.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
