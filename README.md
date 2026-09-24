# Wallet App (core)

    docker compose up --build

API on http://localhost:3001. Seeded users: test1 / ayobami / victorseun @example.com, password `Test1234!`, $1,000 each.
**All amounts are integer cents** (1000 = $10.00).

    # login
    curl -X POST localhost:3001/login -H 'content-type: application/json' \
      -d '{"email":"test1@example.com","password":"Test1234!"}'

    # transfer $25 to account 2 (safe to retry with the same key)
    curl -X POST localhost:3001/transactions/new -H "authorization: Bearer $TOKEN" \
      -H 'idempotency-key: abc-123' -H 'content-type: application/json' \
      -d '{"toAccountId":2,"amount":2500,"description":"lunch"}'
