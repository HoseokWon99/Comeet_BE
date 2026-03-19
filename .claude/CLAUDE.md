# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run start:dev       # Start with watch mode
npm run start:debug     # Start with debugging

# Build
npm run build           # Compile TypeScript to /dist
npm run start:prod      # Run production build

# Tests
npm test                # Unit tests
npm run test:watch      # Unit tests in watch mode
npm run test:cov        # Unit tests with coverage
npm run test:e2e        # E2E tests
```

To run a single test file:
```bash
npx jest src/path/to/file.spec.ts
```

## Architecture

**Stack**: NestJS 11 + TypeORM + PostgreSQL (PostGIS) + Redis (iovalkey)

**Auth flow**: GitHub OAuth2 → JWT (access + refresh tokens). Token blacklist stored in Redis on sign-out. Sign-up sessions also stored in Redis.

**Module structure** under `src/`:
- `auth/` — sign-up/sign-in/sign-out, token refresh, GitHub OAuth2 strategy
- `github/` — GitHub API integration (fetches user profile after OAuth)
- `users/` — user profiles, tech stack, interests, subscriptions, location-based search
- `posts/` — boards, posts, comments, likes, bookmarks, applicants, post count stats
- `tags/` — reusable tag definitions: positions, tech stack, interests
- `common/` — base models (timestamps), PostGIS query utilities, custom interceptors/decorators
- `config/` — TypeORM and Redis configuration (SSL/TLS aware)

**Key patterns**:
- Entities are named `*.model.ts` and auto-discovered by TypeORM
- DTOs live alongside their module; validation via `class-validator`
- `typeorm-transactional` for transaction management
- Custom interceptors handle auth, user location injection, and search filtering
- PostGIS `Point` type used for user and post locations; radius-based queries in `common/`

**Database**: PostgreSQL with `hstore` (tag storage) and `PostGIS` (geospatial queries) extensions required.

**Environment variables needed**: `DB_*`, `REDIS_*`, `JWT_SECRET`, `JWT_ACCESS_EXP`, `JWT_REFRESH_EXP`, `NODE_ENV`, `PORT`, `HOST`, and GitHub OAuth credentials.

**CI/CD**: GitHub Actions builds a Docker image and pushes to Docker Hub on `main`, then triggers SSH deployment to AWS EC2.
