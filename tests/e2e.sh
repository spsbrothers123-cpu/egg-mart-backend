#!/bin/bash
set -uo pipefail
B=http://127.0.0.1:3999/api
PASS=0
FAIL=0

jget() { node -pe "JSON.parse(process.argv[1])['$2']" "$1" 2>/dev/null; }
jstatus() { node -pe "process.argv[1]" "$1" 2>/dev/null; }

check() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" == "$actual" ]; then
    PASS=$((PASS+1)); echo "PASS: $desc"
  else
    FAIL=$((FAIL+1)); echo "FAIL: $desc (expected=$expected actual=$actual)"
  fi
}

req() {
  # req METHOD PATH TOKEN BODY -> prints "STATUS\nBODY"
  local method="$1" path="$2" token="${3:-}" body="${4:-}"
  local auth=()
  [ -n "$token" ] && auth=(-H "Authorization: Bearer $token")
  if [ -n "$body" ]; then
    curl -s -w "\n%{http_code}" -X "$method" "$B$path" "${auth[@]}" -H 'Content-Type: application/json' -d "$body"
  else
    curl -s -w "\n%{http_code}" -X "$method" "$B$path" "${auth[@]}"
  fi
}

echo "########## AUTH ##########"

RESP=$(req POST /auth/login "" '{"username":"admin","password":"admin123"}')
BODY=$(echo "$RESP" | head -n -1); CODE=$(echo "$RESP" | tail -1)
check "Admin login succeeds" "200" "$CODE"
ADMIN_TOKEN=$(jget "$BODY" token)

RESP=$(req POST /auth/login "" '{"username":"cashier","password":"1234"}')
BODY=$(echo "$RESP" | head -n -1); CODE=$(echo "$RESP" | tail -1)
check "Cashier login succeeds" "200" "$CODE"
CASHIER_TOKEN=$(jget "$BODY" token)

RESP=$(req POST /auth/login "" '{"username":"admin","password":"WRONG"}')
CODE=$(echo "$RESP" | tail -1)
check "Invalid credentials rejected" "401" "$CODE"

RESP=$(req POST /auth/register-admin "" '{"name":"Admin B","username":"adminb","password":"Str0ng!Pass1"}')
BODY=$(echo "$RESP" | head -n -1); CODE=$(echo "$RESP" | tail -1)
check "Admin B registration succeeds" "201" "$CODE"
ADMINB_TOKEN=$(jget "$BODY" token)

RESP=$(req POST /auth/register-admin "" '{"name":"Admin B dup","username":"adminb","password":"Str0ng!Pass1"}')
CODE=$(echo "$RESP" | tail -1)
check "Duplicate admin username rejected" "409" "$CODE"

RESP=$(req POST /auth/register-admin "" '{"name":"Weak","username":"weakpw1","password":"weak"}')
CODE=$(echo "$RESP" | tail -1)
check "Weak password rejected on admin signup" "400" "$CODE"

echo
echo "########## MULTI-SHOP ##########"

RESP=$(req POST /shops "$ADMINB_TOKEN" '{"name":"Shop C","location":"Chennai"}')
BODY=$(echo "$RESP" | head -n -1); CODE=$(echo "$RESP" | tail -1)
check "Admin B creates own shop" "201" "$CODE"
SHOPC_ID=$(jget "$BODY" id)

RESP=$(req POST /shops "$ADMIN_TOKEN" '{"name":"Shop B","location":"RS Puram"}')
BODY=$(echo "$RESP" | head -n -1); CODE=$(echo "$RESP" | tail -1)
check "Admin A creates a 2nd shop" "201" "$CODE"
SHOPB_ID=$(jget "$BODY" id)

RESP=$(req GET /shops "$ADMIN_TOKEN")
BODY=$(echo "$RESP" | head -n -1)
SHOP_COUNT=$(node -pe "JSON.parse(process.argv[1]).length" "$BODY")
check "Admin A now owns 2 shops" "2" "$SHOP_COUNT"

RESP=$(req GET /shops "$ADMINB_TOKEN")
BODY=$(echo "$RESP" | head -n -1)
SHOP_COUNT=$(node -pe "JSON.parse(process.argv[1]).length" "$BODY")
check "Admin B owns only 1 shop (isolated)" "1" "$SHOP_COUNT"

RESP=$(req GET "/shops/$SHOPC_ID" "$ADMIN_TOKEN")
CODE=$(echo "$RESP" | tail -1)
check "Admin A cannot read Admin B's shop by ID (IDOR)" "404" "$CODE"

RESP=$(req PUT "/shops/$SHOPC_ID" "$ADMIN_TOKEN" '{"location":"Hacked"}')
CODE=$(echo "$RESP" | tail -1)
check "Admin A cannot modify Admin B's shop" "403" "$CODE"

echo
echo "########## CASHIER CREATION & USERS ##########"

RESP=$(req POST /users "$ADMIN_TOKEN" "{\"name\":\"Ravi\",\"username\":\"ravi_c\",\"password\":\"Str0ng!Pass1\",\"shop_id\":$SHOPB_ID}")
BODY=$(echo "$RESP" | head -n -1); CODE=$(echo "$RESP" | tail -1)
check "Admin A creates cashier for own Shop B" "201" "$CODE"
RAVI_ID=$(jget "$BODY" id)

RESP=$(req POST /users "$ADMIN_TOKEN" "{\"name\":\"Sneaky\",\"username\":\"sneaky_c\",\"password\":\"Str0ng!Pass1\",\"shop_id\":$SHOPC_ID}")
CODE=$(echo "$RESP" | tail -1)
check "Admin A CANNOT create cashier for Admin B's shop (IDOR)" "403" "$CODE"

RESP=$(req POST /users "$ADMIN_TOKEN" '{"name":"X","username":"cashier","password":"Str0ng!Pass1","shop_id":1}')
CODE=$(echo "$RESP" | tail -1)
check "Duplicate username rejected on cashier create" "409" "$CODE"

RESP=$(req POST /users "$ADMIN_TOKEN" '{"name":"Rogue Admin","username":"rogue1","password":"Str0ng!Pass1","shop_id":1,"role":"admin"}')
BODY=$(echo "$RESP" | head -n -1); CODE=$(echo "$RESP" | tail -1)
ROLE=$(jget "$BODY" role)
check "POST /users ignores role=admin override, still creates cashier" "cashier" "$ROLE"

RESP=$(req GET /users "$ADMIN_TOKEN")
BODY=$(echo "$RESP" | head -n -1); CODE=$(echo "$RESP" | tail -1)
check "Admin A lists own cashiers" "200" "$CODE"
HAS_PW=$(node -pe "JSON.parse(process.argv[1]).some(u => 'password' in u)" "$BODY")
check "Users list never exposes password field" "false" "$HAS_PW"

RESP=$(req GET /users "$ADMINB_TOKEN")
BODY=$(echo "$RESP" | head -n -1)
FOUND_RAVI=$(node -pe "JSON.parse(process.argv[1]).some(u => u.username === 'ravi_c')" "$BODY")
check "Admin B cannot see Admin A's cashier (ravi_c)" "false" "$FOUND_RAVI"

RESP=$(req PUT "/users/$RAVI_ID" "$ADMINB_TOKEN" '{"name":"Hacked Name"}')
CODE=$(echo "$RESP" | tail -1)
check "Admin B cannot edit Admin A's cashier" "403" "$CODE"

RESP=$(req PUT "/users/$RAVI_ID" "$ADMIN_TOKEN" '{"name":"Ravi Kumar Updated","username":"ravi_updated"}')
BODY=$(echo "$RESP" | head -n -1); CODE=$(echo "$RESP" | tail -1)
NEWNAME=$(jget "$BODY" name)
check "Admin A can edit permitted cashier name+username" "Ravi Kumar Updated" "$NEWNAME"

RESP=$(req PUT "/users/1" "$ADMIN_TOKEN" '{"name":"Self Edit"}')
CODE=$(echo "$RESP" | tail -1)
check "Admin cannot edit an admin account (incl. self) via /users" "403" "$CODE"

RESP=$(req GET "/users/$RAVI_ID/sessions" "$ADMINB_TOKEN")
CODE=$(echo "$RESP" | tail -1)
check "Admin B cannot read Admin A's cashier session history" "403" "$CODE"

RESP=$(req GET "/users/$RAVI_ID/sessions" "$ADMIN_TOKEN")
CODE=$(echo "$RESP" | tail -1)
check "Admin A CAN read own cashier's session history" "200" "$CODE"

echo
echo "########## SHOP-SCOPED DATA ISOLATION ##########"

RESP=$(req GET /products "$CASHIER_TOKEN")
BODY=$(echo "$RESP" | head -n -1); CODE=$(echo "$RESP" | tail -1)
PROD_COUNT=$(node -pe "JSON.parse(process.argv[1]).length" "$BODY")
echo "Cashier (Shop 1 'Main Shop') sees $PROD_COUNT products (seeded=33 expected)"
check "Cashier sees seeded products in own shop" "33" "$PROD_COUNT"

RESP=$(req POST /products "$ADMIN_TOKEN" "{\"name\":\"Shop B Special Egg\",\"pack\":\"1 Pc\",\"price\":9,\"stock\":50,\"shop_id\":$SHOPB_ID}")
BODY=$(echo "$RESP" | head -n -1); CODE=$(echo "$RESP" | tail -1)
check "Admin A creates a product scoped to Shop B" "201" "$CODE"
SHOPB_PRODUCT_ID=$(jget "$BODY" id)

RESP=$(req GET /products "$CASHIER_TOKEN")
BODY=$(echo "$RESP" | head -n -1)
SEES_SHOPB_PRODUCT=$(node -pe "JSON.parse(process.argv[1]).some(p => p.name === 'Shop B Special Egg')" "$BODY")
check "Main Shop cashier does NOT see Shop B's product" "false" "$SEES_SHOPB_PRODUCT"

RESP=$(req POST /products "$ADMIN_TOKEN" "{\"name\":\"Sneaky Product\",\"pack\":\"1 Pc\",\"price\":5,\"stock\":10,\"shop_id\":$SHOPC_ID}")
CODE=$(echo "$RESP" | tail -1)
check "Admin A cannot create product in Admin B's shop" "403" "$CODE"

echo
echo "########## NORMAL BILLS ##########"

RESP=$(req POST /sessions/open "$CASHIER_TOKEN" '{"opening_cash":500}')
CODE=$(echo "$RESP" | tail -1)
if [ "$CODE" == "400" ]; then
  echo "  (session likely already open from previous run, continuing)"
fi

RESP=$(req GET /products "$CASHIER_TOKEN")
BODY=$(echo "$RESP" | head -n -1)
P1_ID=$(node -pe "JSON.parse(process.argv[1])[0].id" "$BODY")
P1_PRICE=$(node -pe "JSON.parse(process.argv[1])[0].price" "$BODY")
P1_NAME=$(node -pe "JSON.stringify(JSON.parse(process.argv[1])[0].name)" "$BODY")

RESP=$(req POST /bills "$CASHIER_TOKEN" "{\"items\":[{\"product_id\":$P1_ID,\"name\":$P1_NAME,\"price\":$P1_PRICE,\"qty\":2}],\"payment_method\":\"cash\"}")
BODY=$(echo "$RESP" | head -n -1); CODE=$(echo "$RESP" | tail -1)
check "Cashier creates a normal cash bill" "201" "$CODE"
BILL1_ID=$(jget "$BODY" id)

echo
echo "########## SPLIT PAYMENTS ##########"

# Bill total ₹80: 2 items @ ₹40 each say... build items summing to exactly 80
RESP=$(req POST /bills "$CASHIER_TOKEN" '{"items":[{"name":"Loose Item","price":80,"qty":1}],"payment_method":"split","payments":[{"method":"card","amount":60},{"method":"cash","amount":20}]}')
BODY=$(echo "$RESP" | head -n -1); CODE=$(echo "$RESP" | tail -1)
check "Split payment 80 = card60+cash20 succeeds" "201" "$CODE"
SPLIT_BILL_ID=$(jget "$BODY" id)
echo "  bill: $BODY"

RESP=$(req POST /bills "$CASHIER_TOKEN" '{"items":[{"name":"Loose Item","price":80,"qty":1}],"payment_method":"split","payments":[{"method":"gpay","amount":50},{"method":"cash","amount":30}]}')
CODE=$(echo "$RESP" | tail -1)
check "Split payment 80 = gpay50+cash30 succeeds" "201" "$CODE"

RESP=$(req POST /bills "$CASHIER_TOKEN" '{"items":[{"name":"Loose Item","price":80,"qty":1}],"payment_method":"split","payments":[{"method":"card","amount":60},{"method":"cash","amount":10}]}')
BODY=$(echo "$RESP" | head -n -1); CODE=$(echo "$RESP" | tail -1)
check "Underpayment (60+10 vs 80) rejected" "400" "$CODE"
echo "  error: $(jget "$BODY" error)"

RESP=$(req POST /bills "$CASHIER_TOKEN" '{"items":[{"name":"Loose Item","price":80,"qty":1}],"payment_method":"split","payments":[{"method":"card","amount":60},{"method":"cash","amount":30}]}')
BODY=$(echo "$RESP" | head -n -1); CODE=$(echo "$RESP" | tail -1)
check "Overpayment (60+30 vs 80) rejected" "400" "$CODE"
echo "  error: $(jget "$BODY" error)"

RESP=$(req POST /bills "$CASHIER_TOKEN" '{"items":[{"name":"Loose Item","price":80,"qty":1}],"payment_method":"split","payments":[{"method":"bogus","amount":60},{"method":"cash","amount":20}]}')
CODE=$(echo "$RESP" | tail -1)
check "Invalid payment method rejected" "400" "$CODE"

RESP=$(req POST /bills "$CASHIER_TOKEN" '{"items":[{"name":"Loose Item","price":80,"qty":1}],"payment_method":"split","payments":[{"method":"card","amount":-10},{"method":"cash","amount":90}]}')
CODE=$(echo "$RESP" | tail -1)
check "Negative amount rejected" "400" "$CODE"

RESP=$(req POST /bills "$CASHIER_TOKEN" '{"items":[{"name":"Loose Item","price":80,"qty":1}],"payment_method":"split","payments":[{"method":"card","amount":0},{"method":"cash","amount":80}]}')
CODE=$(echo "$RESP" | tail -1)
check "Zero amount portion rejected" "400" "$CODE"

RESP=$(req GET "/bills/$SPLIT_BILL_ID" "$CASHIER_TOKEN")
BODY=$(echo "$RESP" | head -n -1)
PAY_COUNT=$(node -pe "JSON.parse(process.argv[1]).payments.length" "$BODY")
check "Split bill retains individual payment breakdown (2 portions)" "2" "$PAY_COUNT"

echo
echo "########## SHOP-SCOPED BILL ACCESS ##########"

RESP=$(req GET "/bills/$SPLIT_BILL_ID" "$ADMINB_TOKEN")
CODE=$(echo "$RESP" | tail -1)
check "Admin B cannot access Admin A's shop's bill (IDOR)" "403" "$CODE"

RESP=$(req GET "/bills?shop_id=$SHOPC_ID" "$ADMIN_TOKEN")
CODE=$(echo "$RESP" | tail -1)
check "Admin A cannot filter bills by Admin B's shop_id" "403" "$CODE"

echo
echo "########## REPORTS ##########"

TODAY=$(date +%F)
RESP=$(req GET "/reports/payment-methods?from=$TODAY&to=$TODAY" "$ADMIN_TOKEN")
BODY=$(echo "$RESP" | head -n -1); CODE=$(echo "$RESP" | tail -1)
check "Payment-methods report accessible to admin" "200" "$CODE"
echo "  report: $BODY"
CASH_TOTAL=$(node -pe "JSON.parse(process.argv[1]).by_method.find(m=>m.method==='cash')?.total ?? 0" "$BODY")
CARD_TOTAL=$(node -pe "JSON.parse(process.argv[1]).by_method.find(m=>m.method==='card')?.total ?? 0" "$BODY")
UPI_TOTAL=$(node -pe "JSON.parse(process.argv[1]).by_method.find(m=>m.method==='upi')?.total ?? 0" "$BODY")
echo "  cash=$CASH_TOTAL card=$CARD_TOTAL upi=$UPI_TOTAL"
# Expect: split bills contributed card:60, cash:20+30=50, upi(gpay):50 plus the normal cash bill (2 * P1_PRICE)
check "Card total reflects split-payment portion (60)" "60" "$CARD_TOTAL"
check "UPI total reflects gpay-normalized split portion (50)" "50" "$UPI_TOTAL"

RESP=$(req GET "/reports/summary?date=$TODAY" "$CASHIER_TOKEN")
CODE=$(echo "$RESP" | tail -1)
check "Cashier CANNOT access admin reports" "403" "$CODE"

echo
echo "########## CROSS-SHOP CASHIER ACCESS ##########"

RESP=$(req POST /users "$ADMIN_TOKEN" "{\"name\":\"Ravi Login\",\"username\":\"ravi_login\",\"password\":\"Str0ng!Pass1\",\"shop_id\":$SHOPB_ID}")
BODY=$(echo "$RESP" | head -n -1)
RAVI2_ID=$(jget "$BODY" id)

RESP=$(req POST /auth/login "" '{"username":"ravi_login","password":"Str0ng!Pass1"}')
BODY=$(echo "$RESP" | head -n -1)
RAVI_TOKEN=$(jget "$BODY" token)

RESP=$(req POST /sessions/open "$RAVI_TOKEN" '{"opening_cash":0}')
CODE=$(echo "$RESP" | tail -1)
check "Shop B cashier can open own session" "201" "$CODE"

RESP=$(req GET /products "$RAVI_TOKEN")
BODY=$(echo "$RESP" | head -n -1)
SEES_SHOPB_PRODUCT=$(node -pe "JSON.parse(process.argv[1]).some(p => p.name === 'Shop B Special Egg')" "$BODY")
check "Shop B cashier SEES Shop B's own product" "true" "$SEES_SHOPB_PRODUCT"
SEES_MAIN_PRODUCTS=$(node -pe "JSON.parse(process.argv[1]).length" "$BODY")
check "Shop B cashier does NOT see Main Shop's 33 products" "1" "$SEES_MAIN_PRODUCTS"

RESP=$(req POST /bills "$RAVI_TOKEN" "{\"items\":[{\"product_id\":$SHOPB_PRODUCT_ID,\"name\":\"Shop B Special Egg\",\"price\":9,\"qty\":1}],\"payment_method\":\"cash\",\"shop_id\":$SHOPC_ID}")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -n -1)
check "Shop B cashier cannot inject a different shop_id into a bill (ignored/derived server-side)" "201" "$CODE"
BILLED_SHOP=$(jget "$BODY" shop_id)
check "Bill's shop_id was forced to cashier's real shop, not client-supplied value" "$SHOPB_ID" "$BILLED_SHOP"

echo
echo "########## CREDIT SALES & SETTLEMENT ##########"

RESP=$(req POST /customers "$CASHIER_TOKEN" '{"name":"Credit Customer","phone":"9000000000","credit_limit":100}')
BODY=$(echo "$RESP" | head -n -1); CODE=$(echo "$RESP" | tail -1)
check "Cashier creates a customer in own shop" "201" "$CODE"
CREDIT_CUST_ID=$(jget "$BODY" id)

RESP=$(req POST /bills "$CASHIER_TOKEN" "{\"items\":[{\"name\":\"Credit Item\",\"price\":90,\"qty\":1}],\"payment_method\":\"credit\",\"customer_id\":$CREDIT_CUST_ID}")
BODY=$(echo "$RESP" | head -n -1); CODE=$(echo "$RESP" | tail -1)
check "Credit sale within limit (90 of 100) succeeds" "201" "$CODE"
CREDIT_BILL_ID=$(jget "$BODY" id)

RESP=$(req POST /bills "$CASHIER_TOKEN" "{\"items\":[{\"name\":\"Credit Item 2\",\"price\":50,\"qty\":1}],\"payment_method\":\"credit\",\"customer_id\":$CREDIT_CUST_ID}")
CODE=$(echo "$RESP" | tail -1)
check "2nd credit sale exceeding remaining limit (50 > 10 left) rejected" "400" "$CODE"

RESP=$(req PATCH "/bills/$CREDIT_BILL_ID/settle-credit" "$CASHIER_TOKEN" '{"payment_method":"cash"}')
CODE=$(echo "$RESP" | tail -1)
check "Cashier cannot settle credit bills (admin only)" "403" "$CODE"

RESP=$(req PATCH "/bills/$CREDIT_BILL_ID/settle-credit" "$ADMIN_TOKEN" '{"payment_method":"cash"}')
BODY=$(echo "$RESP" | head -n -1); CODE=$(echo "$RESP" | tail -1)
check "Admin settles credit bill" "200" "$CODE"
STATUS=$(jget "$BODY" payment_status)
check "Settled bill now shows payment_status=paid" "paid" "$STATUS"

RESP=$(req GET "/customers/$CREDIT_CUST_ID" "$ADMIN_TOKEN")
BODY=$(echo "$RESP" | head -n -1)
CREDIT_USED=$(jget "$BODY" credit_used)
check "Customer's credit_used freed back to 0 after settlement" "0.00" "$CREDIT_USED"

echo
echo "########## VOID + STOCK RESTORATION ##########"

RESP=$(req GET /products "$CASHIER_TOKEN")
BODY=$(echo "$RESP" | head -n -1)
VOID_PRODUCT_ID=$(node -pe "JSON.parse(process.argv[1])[1].id" "$BODY")
STOCK_BEFORE=$(node -pe "JSON.parse(process.argv[1])[1].stock" "$BODY")
VOID_PRICE=$(node -pe "JSON.parse(process.argv[1])[1].price" "$BODY")
VOID_NAME=$(node -pe "JSON.stringify(JSON.parse(process.argv[1])[1].name)" "$BODY")

RESP=$(req POST /bills "$CASHIER_TOKEN" "{\"items\":[{\"product_id\":$VOID_PRODUCT_ID,\"name\":$VOID_NAME,\"price\":$VOID_PRICE,\"qty\":3}],\"payment_method\":\"cash\"}")
BODY=$(echo "$RESP" | head -n -1); CODE=$(echo "$RESP" | tail -1)
check "Bill for void test created" "201" "$CODE"
VOID_BILL_ID=$(jget "$BODY" id)

RESP=$(req GET "/products/$VOID_PRODUCT_ID" "$CASHIER_TOKEN")
BODY=$(echo "$RESP" | head -n -1)
STOCK_AFTER_SALE=$(jget "$BODY" stock)
EXPECTED_AFTER_SALE=$((STOCK_BEFORE - 3))
check "Stock decremented by 3 after sale" "$EXPECTED_AFTER_SALE" "$STOCK_AFTER_SALE"

RESP=$(req PATCH "/bills/$VOID_BILL_ID/void" "$ADMIN_TOKEN" '{}')
CODE=$(echo "$RESP" | tail -1)
check "Admin voids the bill" "200" "$CODE"

RESP=$(req GET "/products/$VOID_PRODUCT_ID" "$CASHIER_TOKEN")
BODY=$(echo "$RESP" | head -n -1)
STOCK_AFTER_VOID=$(jget "$BODY" stock)
check "Stock restored to original level after void" "$STOCK_BEFORE" "$STOCK_AFTER_VOID"

echo
echo "########## STOCK / OVERSELL PROTECTION ##########"

RESP=$(req POST /bills "$CASHIER_TOKEN" "{\"items\":[{\"product_id\":$VOID_PRODUCT_ID,\"name\":$VOID_NAME,\"price\":$VOID_PRICE,\"qty\":999999}],\"payment_method\":\"cash\"}")
CODE=$(echo "$RESP" | tail -1)
check "Bill for more stock than available is rejected" "400" "$CODE"

echo
echo "########## INVENTORY ADJUSTMENT ##########"

RESP=$(req POST /inventory/adjust "$CASHIER_TOKEN" "{\"product_id\":$VOID_PRODUCT_ID,\"type\":\"in\",\"qty\":10}")
CODE=$(echo "$RESP" | tail -1)
check "Cashier cannot adjust inventory (admin only)" "403" "$CODE"

RESP=$(req POST /inventory/adjust "$ADMIN_TOKEN" "{\"product_id\":$VOID_PRODUCT_ID,\"type\":\"in\",\"qty\":10}")
CODE=$(echo "$RESP" | tail -1)
check "Admin can adjust inventory for own shop's product" "201" "$CODE"

echo
echo "########## SHOP DEACTIVATION ##########"

RESP=$(req DELETE "/shops/$SHOPB_ID" "$ADMIN_TOKEN")
CODE=$(echo "$RESP" | tail -1)
check "Admin deactivates own shop" "204" "$CODE"

RESP=$(req DELETE "/shops/$SHOPC_ID" "$ADMIN_TOKEN")
CODE=$(echo "$RESP" | tail -1)
check "Admin A cannot deactivate Admin B's shop" "403" "$CODE"

echo
echo "########## FRONTEND-CONTRACT RECONCILIATION ##########"

# By this point in the script Admin A (seeded) + Admin B already exist, so
# a brand-new cashier signup with a never-seen-before location must be
# refused rather than guessed at (see the standalone single-admin
# happy-path verification run separately for the auto-create case).
RESP=$(req POST /auth/register "" '{"username":"soloadmin","password":"Str0ng!Pass1","role":"admin"}')
BODY=$(echo "$RESP" | head -n -1); CODE=$(echo "$RESP" | tail -1)
check "Unified /auth/register creates an admin (no name field sent)" "201" "$CODE"

RESP=$(req POST /auth/register "" '{"username":"unmatchedcashier","password":"Str0ng!Pass1","role":"cashier","shop_location":"Some New Place Nobody Made Yet"}')
CODE=$(echo "$RESP" | tail -1)
check "Cashier signup with an unrecognized location is refused when multiple admins exist (no unsafe auto-assignment)" "400" "$CODE"

# A cashier signing up with an EXISTING shop's exact location (case-insensitive)
# should join that shop — this works regardless of how many admins exist,
# since the match is unambiguous.
RESP=$(req GET /shops "$ADMIN_TOKEN")
BODY=$(echo "$RESP" | head -n -1)
EXISTING_LOCATION=$(node -pe "JSON.parse(process.argv[1])[0].location" "$BODY")

RESP=$(req POST /auth/register "" "{\"username\":\"joincashier\",\"password\":\"Str0ng!Pass1\",\"role\":\"cashier\",\"shop_location\":\"$EXISTING_LOCATION\"}")
BODY=$(echo "$RESP" | head -n -1); CODE=$(echo "$RESP" | tail -1)
check "Cashier signup joins an existing shop by exact location match" "201" "$CODE"
JOINED_SHOP_ID=$(node -pe "JSON.parse(process.argv[1]).user.shop_id" "$BODY")
JOINED_LOCATION=$(node -pe "JSON.parse(process.argv[1]).user.shop_location" "$BODY")
check "Response includes flat shop_location field" "$EXISTING_LOCATION" "$JOINED_LOCATION"

# PATCH alias for editing a cashier
RESP=$(req PATCH "/users/$RAVI_ID" "$ADMIN_TOKEN" '{"name":"Ravi Patched"}')
BODY=$(echo "$RESP" | head -n -1); CODE=$(echo "$RESP" | tail -1)
check "PATCH /api/users/:id works (frontend uses PATCH, not PUT)" "200" "$CODE"
PATCHED_NAME=$(jget "$BODY" name)
check "PATCH actually updated the name" "Ravi Patched" "$PATCHED_NAME"

# Flat shop_location field on GET /api/users (Users & Sessions page reads this)
RESP=$(req GET /users "$ADMIN_TOKEN")
BODY=$(echo "$RESP" | head -n -1); CODE=$(echo "$RESP" | tail -1)
check "GET /api/users succeeds" "200" "$CODE"
HAS_FLAT_LOCATION=$(node -pe "JSON.parse(process.argv[1]).every(u => typeof u.shop_location === 'string')" "$BODY")
check "GET /api/users returns flat shop_location on every cashier" "true" "$HAS_FLAT_LOCATION"

echo
echo "########## ADMIN WRITES WITHOUT shop_id (frontend has no shop-picker UI) ##########"

# Admin B owns exactly 1 shop at this point -> shop_id should be optional
# and silently default to it, matching how ProductsPage.jsx actually calls
# POST /api/products (it never sends shop_id).
RESP=$(req POST /products "$ADMINB_TOKEN" '{"name":"No Shop Id Product","pack":"1 Pc","price":5,"stock":10}')
BODY=$(echo "$RESP" | head -n -1); CODE=$(echo "$RESP" | tail -1)
check "Admin with exactly 1 shop can create a product with no shop_id (matches frontend payload)" "201" "$CODE"
DEFAULTED_SHOP_ID=$(jget "$BODY" shop_id)
check "Product defaulted to that admin's sole shop" "$SHOPC_ID" "$DEFAULTED_SHOP_ID"

# Admin A owns 2 shops at this point -> omitting shop_id must be refused
# rather than guessing which shop the product belongs to.
RESP=$(req POST /products "$ADMIN_TOKEN" '{"name":"Ambiguous Shop Product","pack":"1 Pc","price":5,"stock":10}')
CODE=$(echo "$RESP" | tail -1)
check "Admin with 2+ shops omitting shop_id is refused (ambiguous, not guessed)" "400" "$CODE"

RESP=$(req POST /customers "$ADMINB_TOKEN" '{"name":"No Shop Id Customer"}')
CODE=$(echo "$RESP" | tail -1)
check "Admin with exactly 1 shop can create a customer with no shop_id" "201" "$CODE"

echo
echo "########## SPLIT PAYMENT PAYLOAD SHAPE (frontend method casing) ##########"

# BillingPage.jsx sends payment portions with capitalized methods
# ("Cash"/"Card"/"UPI") — App.jsx's addTransaction fix lowercases them
# before calling the API, so the backend should accept lowercase methods
# exactly as the fixed frontend now sends them.
RESP=$(req POST /bills "$CASHIER_TOKEN" '{"items":[{"name":"Frontend-style Split","price":80,"qty":1}],"payment_method":"split","payments":[{"method":"cash","amount":30},{"method":"upi","amount":50}]}')
CODE=$(echo "$RESP" | tail -1)
check "Split payment with frontend-style lowercased methods succeeds" "201" "$CODE"

echo
echo "########## RESULTS ##########"
echo "PASS=$PASS FAIL=$FAIL"
