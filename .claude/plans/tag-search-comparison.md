# Tag-Based User Search: Three Approaches Comparison Plan

## Context

Users are searched by three tag types: **position**, **techStack**, **interests**. Currently, `techStack` and `interests` are stored as `hstore` columns on the `users` table (no GIN index), and `position` is stored as `jsonb`. The `?|` operator is used for hstore filtering, and `position['id'] IN (...)` for position. Without indexes, these are sequential scans on every search query.

Goal: Compare three storage/indexing strategies and pick the best one.

---

## Current State (Baseline)

| Column | Type | Query | Index |
|--------|------|-------|-------|
| `position` | jsonb | `user.position['id'] IN :...ids` | None |
| `tech_stack` | hstore | `user.tech_stack ?| ARRAY[...]` | None |
| `interests` | hstore | `user.interests ?| ARRAY[...]` | None |

**Key files:**
- `src/users/model/user.model.ts` — entity definition
- `src/users/service/service.internal.ts` — WhereClause + setSelectClause
- `src/users/service/search.users.service.ts` — search queries
- `src/users/internal/types-record-transform.ts` — hstore ↔ TypeDTO[] transformer

---

## Three Scenarios

### Scenario A: Join Tables (Normalized)

Create junction tables for each tag type:

```sql
CREATE TABLE user_positions (
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  position_id INT REFERENCES positions(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, position_id)
);

CREATE TABLE user_tech_stack (
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  tech_id INT REFERENCES techs(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, tech_id)
);

CREATE TABLE user_interests (
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  interest_id INT REFERENCES interests(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, interest_id)
);

-- Indexes on tag_id columns for filtering
CREATE INDEX idx_user_positions_pid ON user_positions(position_id);
CREATE INDEX idx_user_tech_stack_tid ON user_tech_stack(tech_id);
CREATE INDEX idx_user_interests_iid ON user_interests(interest_id);
```

**Query pattern:**
```sql
SELECT ... FROM users u
WHERE u.id IN (
  SELECT user_id FROM user_tech_stack WHERE tech_id IN (1, 2, 3)
)
AND u.id IN (
  SELECT user_id FROM user_interests WHERE interest_id IN (4, 5)
)
AND u.id IN (
  SELECT user_id FROM user_positions WHERE position_id IN (6)
);
```

Or using `EXISTS` / `JOIN`:
```sql
SELECT ... FROM users u
JOIN user_tech_stack ut ON u.id = ut.user_id AND ut.tech_id IN (1,2,3)
JOIN user_interests ui ON u.id = ui.user_id AND ui.interest_id IN (4,5)
...
GROUP BY u.id;
```

**Pros:**
- Standard relational pattern, referential integrity enforced by FK
- B-tree indexes on integer columns → very fast lookups
- Easy to add metadata (e.g., skill level, priority) to junction rows later
- Straightforward aggregation queries (count users per tag, etc.)

**Cons:**
- 3 extra tables + 3 extra indexes to maintain
- Write amplification: updating a user's tags = DELETE + INSERT on junction tables (inside transaction)
- Read requires JOINs or subqueries → more complex query builder code
- `setSelectClause` needs significant rewrite to JOIN and aggregate tag values back
- Migration is the most complex of the three options

---

### Scenario B: Current hstore + GIN Index (Minimal Change)

Keep hstore columns as-is, just add GIN indexes:

```sql
CREATE INDEX idx_users_tech_stack ON users USING GIN(tech_stack);
CREATE INDEX idx_users_interests ON users USING GIN(interests);
CREATE INDEX idx_users_position ON users USING GIN(position jsonb_path_ops);
```

**Query pattern:** Unchanged (`?|` operator already supported by GIN on hstore).

**Pros:**
- Minimal code change — just a migration to add indexes
- `?|` operator is GIN-accelerated on hstore natively
- No schema change, no data migration
- Zero application code changes

**Cons:**
- hstore is a legacy extension; PostgreSQL community favors jsonb
- hstore stores only `text → text` pairs (no nested structures)
- `hstore_to_jsonb()` conversion on every SELECT is overhead
- GIN index on hstore is slightly less flexible than on jsonb (no `@>` containment, no path queries)

---

### Scenario C: JSONB + GIN Index

Convert hstore columns to jsonb arrays and add GIN indexes:

```sql
-- Migration
ALTER TABLE users
  ALTER COLUMN tech_stack TYPE jsonb USING hstore_to_jsonb(tech_stack),
  ALTER COLUMN interests TYPE jsonb USING hstore_to_jsonb(interests);

-- Store as arrays of IDs: [1, 2, 3] for fast containment checks
-- Or as array of objects: [{"id": 1, "value": "JavaScript"}, ...]

CREATE INDEX idx_users_tech_stack_gin ON users USING GIN(tech_stack jsonb_path_ops);
CREATE INDEX idx_users_interests_gin ON users USING GIN(interests jsonb_path_ops);
CREATE INDEX idx_users_position_gin ON users USING GIN(position jsonb_path_ops);
```

**Option C-1: Store full objects `[{"id":1,"value":"JS"}, ...]`**
- Query: `tech_stack @> '[{"id": 1}]'` (GIN-accelerated with `jsonb_path_ops`)
- No need for `hstore_to_jsonb()` in SELECT
- Slightly larger storage per row

**Option C-2: Store ID arrays `[1, 2, 3]` + lookup values from tag tables**
- Query: `tech_stack_ids @> '[1, 2]'` (GIN-accelerated)
- Smallest storage, but requires JOIN to get tag values for display
- Adds a join similar to Scenario A but simpler

**Pros:**
- jsonb is the modern PostgreSQL standard, well-optimized
- `@>` containment operator is GIN-accelerated and very fast
- No `hstore_to_jsonb()` conversion needed on SELECT
- Rich querying capabilities (path queries, containment, existence)
- Position column is already jsonb → consistent column types

**Cons:**
- Requires data migration (hstore → jsonb)
- Need to rewrite transformer and query builder code
- `?|` (any key exists) query pattern changes to `@>` (containment) or `?|` on jsonb

---

## Comparison Matrix

| Criteria | A: Join Tables | B: hstore + GIN | C: JSONB + GIN |
|----------|---------------|-----------------|----------------|
| **Read perf (filtered search)** | Fast (B-tree on int FK) | Fast (GIN on hstore) | Fast (GIN `@>`) |
| **Write perf (update tags)** | Slow (multi-row DELETE+INSERT) | Fast (single column update) | Fast (single column update) |
| **Migration effort** | High (3 tables, data migration, code rewrite) | Very Low (add indexes only) | Medium (column type change, code updates) |
| **Code change** | Large (new entities, repos, query builder rewrite) | None | Medium (transformer, query builder) |
| **Storage overhead** | Higher (junction table rows + indexes) | Baseline | Similar to baseline |
| **Referential integrity** | FK enforced | None | None |
| **Future flexibility** | Best (metadata on relations) | Limited | Good (nested structures) |
| **PostgreSQL ecosystem** | Standard relational | Legacy extension | Modern standard |

---

## Benchmark Plan

### Step 1: Set up test data
- Create a SQL seed script that generates N users (e.g., 10K, 50K, 100K) with random tags
- Each user gets 1 position, 3-8 tech stack items, 2-5 interests (from ~50 tech tags, ~30 interest tags, ~20 positions)

### Step 2: Benchmark each scenario
For each scenario, run `EXPLAIN ANALYZE` on the main search query pattern:

```sql
-- Filter by techIds=[1,2,3], interestIds=[4,5], positionId=[6]
-- + radius filter + ORDER BY distance
-- Measure: planning time, execution time, index usage
```

Test cases:
1. Single tag filter (techIds only)
2. Multi-tag filter (all three)
3. Multi-tag + geo radius filter (the actual production query)
4. Varying data sizes (10K, 50K, 100K rows)

### Step 3: Compare results
Collect planning time, execution time, rows scanned, index hit rate for each.

---

## Recommendation (Preliminary)

**Scenario B (hstore + GIN)** is the best ROI if performance is the only concern — zero code changes, just add indexes via migration, and the `?|` operator is already GIN-accelerated.

**Scenario C (JSONB + GIN)** is the best long-term choice — eliminates `hstore_to_jsonb()` overhead on every read, uses the modern PostgreSQL standard, and provides richer query capabilities. Medium migration effort.

**Scenario A (Join Tables)** is the best if you need referential integrity or plan to add metadata to tag relationships (e.g., skill level). Highest migration cost.

---

## Implementation Steps (for whichever scenario is chosen)

### If B (hstore + GIN):
1. Create migration: add GIN indexes on `tech_stack`, `interests`, `position`
2. Run `EXPLAIN ANALYZE` to verify index usage
3. Done

### If C (JSONB + GIN):
1. Create migration: ALTER COLUMN types from hstore to jsonb
2. Add GIN indexes on new jsonb columns
3. Update `user.model.ts`: change column types from hstore to jsonb
4. Update/remove `types-record-transform.ts` transformer
5. Update `service.internal.ts`: change `?|` queries to `@>` containment
6. Remove `hstore_to_jsonb()` from `setSelectClause`
7. Update `createUser`/`updateUser` to store jsonb format
8. Run tests

### If A (Join Tables):
1. Create 3 new entity models (`user_positions.model.ts`, etc.)
2. Create migration for tables + indexes
3. Data migration script: extract hstore/jsonb data into junction rows
4. Rewrite `WhereClause` to use subqueries/JOINs
5. Rewrite `setSelectClause` to JOIN and aggregate tag values
6. Update `UsersService.createUser`/`updateUser` to manage junction rows
7. Remove hstore columns from users table
8. Remove hstore transformer
9. Run tests

## Verification
- Run `EXPLAIN ANALYZE` on search queries before and after
- Run existing unit/e2e tests: `npm test` and `npm run test:e2e`
- Manual test via API: `GET /api/users/search/near?techIds=1,2&interestIds=3&positionIds=4&radius=5000`
