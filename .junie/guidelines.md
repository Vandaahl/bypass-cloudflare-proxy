# Project Guidelines

## Build/Configuration Instructions

### Prerequisites
- [Docker](https://www.docker.com/) and [Docker Compose](https://docs.docker.com/compose/) installed.
- [Node.js](https://nodejs.org/) (v22+) and [pnpm](https://pnpm.io/) for local development.

### Docker Setup
The project is designed to run in a triple-service Docker setup:
1.  **Unflare**: Headless browser API (Puppeteer) for Cloudflare bypass.
2.  **Addon Proxy**: Lightweight Node.js server to proxy requests using Unflare clearance.
3.  **XML Processor**: Specialized service for handling and modifying XML requests. It can fetch content through the Addon Proxy or directly from a target URL.

To start all services:
```bash
docker-compose up -d
```

### Local Development (Unflare Service)
1.  **Install dependencies**:
    ```bash
    pnpm install
    ```
2.  **Configuration**:
    Create a `.env.development` file in the root based on `src/common/utils/envConfig.ts`.
    Example:
    ```env
    NODE_ENV=development
    HOST=localhost
    PORT=5002
    CORS_ORIGIN=http://localhost:3000
    COMMON_RATE_LIMIT_MAX_REQUESTS=1000
    COMMON_RATE_LIMIT_WINDOW_MS=1000
    ```
3.  **Run in development mode**:
    ```bash
    pnpm dev
    ```

### Configuration Details
- Environment variables are validated using `envalid` in `src/common/utils/envConfig.ts`.
- `dotenv` loads the appropriate `.env.[NODE_ENV]` file.

---

## Testing Information

### Configuring and Running Tests
The project uses [Vitest](https://vitest.dev/) for testing.

- **Run tests locally**:
  ```bash
  pnpm test
  ```
- **Run tests inside Docker**:
  ```bash
  docker-compose run unflare pnpm test
  ```

### Guidelines for Adding and Executing New Tests
- Place tests in `src/` with the suffix `.test.ts` (e.g., `src/api/scraper/scrapeClearance.test.ts`).
- Avoid adding tests to `index.ts` or `src/**/__tests__/**` if you want them included in the production build (as per `tsup` config).
- Use `vitest` globals if needed (configured in `vite.config.mts`).

### Example Test Case
Create a file `src/example.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';

describe('Simple Math', () => {
    it('should add numbers correctly', () => {
        expect(1 + 1).toBe(2);
    });
});
```
Execute it:
```bash
pnpm test -- src/example.test.ts
```

---

## Additional Development Information

### Code Style and Linting
- **Biome**: The project uses [Biome](https://biomejs.dev/) for formatting and linting.
  - Lint: `pnpm lint`
  - Format: `pnpm format`
- **TypeScript**: Strict mode is enabled in `tsconfig.json`.

### Project Structure
- `src/api/scraper/`: Core logic for browser interaction and clearance scraping.
- `src/common/`: Shared utilities, middleware, and environment configuration.
- `src/server.ts`: Express application setup and middleware integration.
- `src/scraperRouter.ts`: API route definitions.
- `script.js`: Main logic for the lightweight Addon Proxy service.
- `xml-processor/`: Service for processing XML content. It acts as an entry point for XML requests.

### Debugging
- Logs are generated using `pino`. In development, they are piped through `pino-pretty`.
- Puppeteer screenshots on failure are handled in `src/api/scraper/scrapeClearance.ts` using `takeScreenshot`.
