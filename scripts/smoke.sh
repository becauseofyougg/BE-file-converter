#!/usr/bin/env bash
# End-to-end smoke test against a running `docker compose` stack.
#
# Drives the real flows through the gateway — register, the code from Mailhog,
# profile, IDOR, refresh, RBAC, email change, erasure — and checks what they
# leave behind in the databases. Unit and e2e tests mock the broker and the
# databases; this is what catches the failures that only exist between them.
#
#   docker compose up -d --build
#   npm run smoke                       # or: bash scripts/smoke.sh
#
# Exits non-zero if any check fails. Needs curl, node and docker on the PATH.
set -u

GW=${GATEWAY_URL:-http://localhost:3000}
MH=${MAILHOG_URL:-http://localhost:8025}
# Overridable so a second stack, under another project name, can be checked.
PG=${POSTGRES_CONTAINER:-fc-postgres}
MQ=${RABBITMQ_CONTAINER:-fc-rabbitmq}
PASSWORD='a perfectly fine passphrase'
PASS=0
FAIL=0

DIR=$(mktemp -d)
# Git Bash hands node a /tmp path it cannot open; give it the Windows one.
command -v cygpath > /dev/null && DIR=$(cygpath -m "$DIR")
JAR=$DIR/jar
trap 'rm -rf "$DIR"' EXIT

check() { # name expected actual
  if [ "$2" = "$3" ]; then
    echo "  ok   $1 ($3)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $1: expected $2, got $3"
    FAIL=$((FAIL + 1))
  fi
}

req() { # method path [json] -> status on stdout, body in $DIR/body
  local method=$1 path=$2 data=${3:-}
  if [ -n "$data" ]; then
    curl -s -o "$DIR/body" -w '%{http_code}' -b "$JAR" -c "$JAR" -X "$method" \
      -H 'content-type: application/json' --data "$data" "$GW$path"
  else
    curl -s -o "$DIR/body" -w '%{http_code}' -b "$JAR" -c "$JAR" -X "$method" "$GW$path"
  fi
}

field() { # JS expression over the last body, bound to `b`
  node -e "const b=JSON.parse(require('fs').readFileSync('$DIR/body','utf8'));const v=$1;console.log(v===undefined?'':v)"
}

sql() { # database query
  docker exec "$PG" sh -c "psql -tA -U \"\$POSTGRES_USER\" -d $1 -c \"$2\""
}

mail_code() { # address [subject pattern] -> the 6-digit code in the newest matching mail
  local address=$1 subject=${2:-.}
  for _ in $(seq 1 30); do
    code=$(curl -s "$MH/api/v2/search?kind=to&query=$address" | node -e "
      let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
        const items=(JSON.parse(d).items||[])
          .filter(m=>new RegExp('$subject','i').test(m.Content.Headers.Subject[0]))
          .sort((a,b)=>new Date(b.Created)-new Date(a.Created));
        const m=items.length?items[0].Content.Body.replace(/=\r?\n/g,'').match(/\b(\d{6})\b/):null;
        console.log(m?m[1]:'')})")
    [ -n "$code" ] && { echo "$code"; return; }
    sleep 1
  done
}

mail_count() {
  curl -s "$MH/api/v2/search?kind=to&query=$1" |
    node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).total))"
}

register() { # address -> user id, session in $JAR
  rm -f "$JAR"
  req POST /auth/register "{\"email\":\"$1\",\"password\":\"$PASSWORD\"}" > /dev/null
  local challenge
  challenge=$(field b.challengeId)
  req POST /auth/verify-email "{\"challengeId\":\"$challenge\",\"code\":\"$(mail_code "$1")\"}" > /dev/null
  field b.userId
}

echo "== every service is ready, with its dependencies"
for service in "api-gateway 3000" "identity-service 3001" "conversion-service 3002" "notification-service 3003"; do
  set -- $service
  container=$(docker compose ps -q "$1")
  # 127.0.0.1, not localhost: in Alpine `localhost` resolves to ::1 first and
  # the services listen on IPv4.
  status=$(docker exec "$container" wget -qO- -T 8 "http://127.0.0.1:$2/health" 2> /dev/null |
    node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.status+':'+Object.keys(j.details).sort().join(','))}catch{console.log('unreachable')}})")
  case $1 in
    api-gateway) expected='ok:rabbitmq,storage' ;;
    conversion-service) expected='ok:database,storage' ;;
    *) expected='ok:database' ;;
  esac
  check "$1 /health" "$expected" "$status"
done

echo "== registration"
EMAIL="smoke-$(date +%s)@example.com"
check "POST /auth/register" 202 "$(req POST /auth/register "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")"
CHALLENGE=$(field b.challengeId)
CODE=$(mail_code "$EMAIL")
check "verification mail arrived with a code" yes "$([ -n "$CODE" ] && echo yes || echo no)"
check "POST /auth/verify-email" 200 "$(req POST /auth/verify-email "{\"challengeId\":\"$CHALLENGE\",\"code\":\"$CODE\"}")"
USER_ID=$(field b.userId)
check "session cookies set" yes "$(grep -q access_token "$JAR" && grep -q refresh_token "$JAR" && echo yes || echo no)"
check "a wrong code is a 4xx refusal, not a 500" yes "$(s=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' --data "{\"challengeId\":\"$CHALLENGE\",\"code\":\"000000\"}" "$GW/auth/verify-email"); [ "$s" -ge 400 ] && [ "$s" -lt 500 ] && echo yes || echo "no ($s)")"

echo "== profile"
check "GET /users/:self" 200 "$(req GET "/users/$USER_ID")"
check "  own email visible" "$EMAIL" "$(field b.email)"
check "PATCH /users/:self displayName" 200 "$(req PATCH "/users/$USER_ID" '{"displayName":"Smoke Test"}')"
check "  change persisted" "Smoke Test" "$(req GET "/users/$USER_ID" > /dev/null; field b.displayName)"
check "PATCH own email directly is refused" 403 "$(req PATCH "/users/$USER_ID" '{"email":"other@example.com"}')"
check "GET someone else's profile (IDOR)" 403 "$(req GET /users/00000000-0000-4000-8000-000000000000)"
check "GET /admin/users as a plain user" 403 "$(req GET /admin/users)"

echo "== session"
check "POST /auth/refresh rotates" 200 "$(req POST /auth/refresh)"
check "a malformed refresh cookie is a 401, not a 500" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'cookie: refresh_token=garbage' "$GW/auth/refresh")"
check "no credentials is a 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$GW/users/$USER_ID")"

echo "== admin (promoted the way README describes)"
sql identity "INSERT INTO user_roles (user_id, role_id) SELECT '$USER_ID', id FROM roles WHERE name = 'ADMIN' ON CONFLICT DO NOTHING" > /dev/null
check "refresh picks up the new role" 200 "$(req POST /auth/refresh)"
check "GET /admin/users as ADMIN" 200 "$(req GET '/admin/users?limit=5')"
check "  paginated list returned" yes "$(field "Array.isArray(b.items)?'yes':'no'")"
check "GET /admin/rbac/roles as ADMIN" 200 "$(req GET /admin/rbac/roles)"

echo "== conversion (docs/CONVERSIONS.md)"
convert() { # file name target [save] -> status; body in $DIR/body, headers in $DIR/headers
  curl -s -o "$DIR/body" -D "$DIR/headers" -w '%{http_code}' -b "$JAR" \
    -F "file=@$1;filename=$2" -F "targetFormat=$3" ${4:+-F "save=$4"} "$GW/api/convert"
}
header() { # name -> value from the last response
  tr -d '\r' < "$DIR/headers" | awk -v name="$(echo "$1" | tr 'A-Z' 'a-z')" -F': ' 'tolower($1) == name {print $2}'
}
printf 'id,name\r\n1,Ann\r\n2,"Smith, J"\r\n' > "$DIR/people.csv"
printf '[{"id":"1","name":"Ann"},{"id":"2","name":"Smith, J"}]' > "$DIR/people.json"
printf '<people><person><id>1</id><name>Ann</name></person><person><id>2</id><name>Smith, J</name></person></people>' > "$DIR/people.xml"
printf -- '- id: "1"\n  name: Ann\n- id: "2"\n  name: Smith, J\n' > "$DIR/people.yaml"

check "GET /api/convert/formats" 200 "$(req GET /api/convert/formats)"
check "  four sources, three targets each" "csv:json,xml,yaml|json:csv,xml,yaml|xml:csv,json,yaml|yaml:csv,json,xml" \
  "$(field "b.map(e=>e.source+':'+e.target.join(',')).join('|')")"
check "POST /api/convert without a session" 401 "$(curl -s -o /dev/null -w '%{http_code}' -F "file=@$DIR/people.csv" -F targetFormat=json "$GW/api/convert")"

for source in csv json xml yaml; do
  for target in csv json xml yaml; do
    [ "$source" = "$target" ] && continue
    status=$(convert "$DIR/people.$source" "people.$source" "$target")
    # Converted back to JSON, every route must give the same two records.
    cp "$DIR/body" "$DIR/result.$target"
    back=$([ "$target" = json ] && cat "$DIR/body" || { convert "$DIR/result.$target" "result.$target" json > /dev/null; cat "$DIR/body"; })
    records=$(echo "$back" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{let v=JSON.parse(d);while(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===1)v=Object.values(v)[0];console.log(JSON.stringify(v))})" 2> /dev/null)
    check "$source → $target" '200|[{"id":"1","name":"Ann"},{"id":"2","name":"Smith, J"}]' "$status|$records"
  done
done

convert "$DIR/people.csv" people.csv json > /dev/null
check "  served as an attachment named converted.json" 'attachment; filename="converted.json"' "$(header content-disposition)"
check "  with the target's type" "application/json; charset=utf-8" "$(header content-type)"
check "  and the history id" yes "$(header x-conversion-id | grep -Eq '^[0-9a-f-]{36}$' && echo yes || echo no)"
UNSAVED_ID=$(header x-conversion-id)

printf 'id,name\r\n1,Ann\r\n' > "$DIR/people.txt"
check "an unrecognised format is 415" "415|UNSUPPORTED_FORMAT" "$(convert "$DIR/people.txt" people.txt json)|$(field b.code)"
check "an unknown target is 400" "400|UNSUPPORTED_CONVERSION" "$(convert "$DIR/people.csv" people.csv toml)|$(field b.code)"
check "a file that does not parse is 400" "400|INVALID_SOURCE" "$(printf '{"a":' > "$DIR/bad.json"; convert "$DIR/bad.json" bad.json csv)|$(field b.code)"
check "an XML external entity is refused" "400|INVALID_SOURCE" "$(printf '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>' > "$DIR/xxe.xml"; convert "$DIR/xxe.xml" xxe.xml json)|$(field b.code)"
node -e "require('fs').writeFileSync('$DIR/big.json', '[' + '1,'.repeat(5_600_000) + '1]')"
check "over the format's limit is 413" "413|FILE_TOO_LARGE" "$(convert "$DIR/big.json" big.json csv)|$(field b.code)"

check "save=true" 200 "$(convert "$DIR/people.yaml" people.yaml xml true)"
SAVED_ID=$(header x-conversion-id)
cp "$DIR/body" "$DIR/saved.xml"
check "GET /api/convert/history" 200 "$(req GET '/api/convert/history?limit=100')"
check "  every attempt recorded, failures included" yes "$(field "b.items.length>=18&&b.items.some(i=>i.status==='FAILED')?'yes':'no'")"
check "  the saved one is downloadable, the unsaved one not" "true|false" \
  "$(field "[b.items.find(i=>i.id==='$SAVED_ID').resultAvailable,b.items.find(i=>i.id==='$UNSAVED_ID').resultAvailable].join('|')")"
check "GET …/history/:id/download" 200 "$(curl -s -o "$DIR/download.xml" -w '%{http_code}' -b "$JAR" "$GW/api/convert/history/$SAVED_ID/download")"
check "  the same bytes as the original response" yes "$(cmp -s "$DIR/saved.xml" "$DIR/download.xml" && echo yes || echo no)"
check "  an unsaved result is not offered" "404|RESULT_NOT_SAVED" "$(req GET "/api/convert/history/$UNSAVED_ID/download")|$(field b.code)"
check "  another user's id is just not found" 404 "$(req GET /api/convert/history/00000000-0000-4000-8000-000000000000)"
check "operations recorded with checksums, no content" yes \
  "$(sql conversion "SELECT CASE WHEN count(*) >= 18 AND bool_and(source_checksum IS NULL OR length(source_checksum) = 64) THEN 'yes' ELSE 'no' END FROM conversion_operations WHERE user_id = '$USER_ID'")"
check "nothing left unacknowledged on conversion.rpc" 0 "$(docker exec "$MQ" rabbitmqctl list_queues name messages_unacknowledged 2> /dev/null | awk '$1 == "conversion.rpc" {print $2}')"
if [ "$(docker compose exec -T api-gateway printenv STORAGE_DRIVER | tr -d '\r')" = local ]; then
  check "no upload left behind (local storage)" 0 "$(docker compose exec -T api-gateway sh -c "ls /var/lib/file-converter/storage/uploads/$USER_ID 2> /dev/null | wc -l" | tr -d ' \r')"
fi

echo "== logout"
check "POST /auth/logout" 204 "$(req POST /auth/logout)"
check "  cookies cleared, profile refused" 401 "$(req GET "/users/$USER_ID")"

echo "== mail and send log"
check "exactly one mail sent to the address" 1 "$(mail_count "$EMAIL")"
check "send log row, SENT" "user.registered|SENT" "$(sql notification "SELECT type || '|' || status FROM notifications WHERE user_id = '$USER_ID'")"

echo "== email change and erasure (a second, fresh account)"
OLD_EMAIL="smoke2-$(date +%s)@example.com"
NEW_EMAIL="moved-$(date +%s)@example.com"
USER2=$(register "$OLD_EMAIL")
check "POST /users/:self/email-change" 200 "$(req POST "/users/$USER2/email-change" "{\"newEmail\":\"$NEW_EMAIL\"}")"
CHALLENGE=$(field b.challengeId)
CODE=$(mail_code "$NEW_EMAIL")
check "  code went to the NEW address" yes "$([ -n "$CODE" ] && echo yes || echo no)"
check "POST /users/:self/email-change/confirm" 200 "$(req POST "/users/$USER2/email-change/confirm" "{\"challengeId\":\"$CHALLENGE\",\"code\":\"$CODE\"}")"
check "  profile shows the new address" "$NEW_EMAIL" "$(req GET "/users/$USER2" > /dev/null; field b.email)"
check "  the OLD address was told (verification + notice)" 2 "$(for _ in $(seq 1 20); do n=$(mail_count "$OLD_EMAIL"); [ "$n" = 2 ] && break; sleep 1; done; echo "$n")"
DELETE_STATUS=$(req DELETE "/users/$USER2" '{}')
check "DELETE /users/:self asks for confirmation" yes "$([ "$DELETE_STATUS" = 200 ] || [ "$DELETE_STATUS" = 202 ] && echo yes || echo "no ($DELETE_STATUS)")"
CHALLENGE=$(field b.challengeId)
CODE=$(mail_code "$NEW_EMAIL" deletion)
check "  deletion code mailed" yes "$([ -n "$CODE" ] && echo yes || echo no)"
check "POST /users/:self/deletion/confirm" 204 "$(req POST "/users/$USER2/deletion/confirm" "{\"challengeId\":\"$CHALLENGE\",\"code\":\"$CODE\"}")"
check "  the account is gone for its owner" 401 "$(req GET "/users/$USER2")"
check "  row anonymised, not dropped" "deleted-$USER2@invalid" "$(sql identity "SELECT email FROM users WHERE id = '$USER2'")"
check "  farewell mail sent" yes "$(for _ in $(seq 1 20); do curl -s "$MH/api/v2/search?kind=to&query=$NEW_EMAIL" | grep -q 'has been deleted' && { echo yes; break; }; sleep 1; done)"

echo "== what the outbox keeps"
# Every event above has been relayed by now — the mails arrived. None of them
# may still carry its payload: codes, link tokens, the erased address.
check "published rows hold no payload" 0 "$(sql identity "SELECT count(*) FROM outbox WHERE published_at IS NOT NULL AND payload <> '{}'::jsonb")"
check "  the erased address is nowhere in it" 0 "$(sql identity "SELECT count(*) FROM outbox WHERE payload::text LIKE '%$NEW_EMAIL%'")"

echo "== hardening"
# One request with an over-long x-correlation-id used to fail identity's
# validation before any handler ran, leave the message unacked, and stop
# identity answering anyone — surviving restarts, since the broker redelivered
# the same message. Both halves are checked: the request, and that the next one
# is still answered.
LONG_ID=$(printf 'a%.0s' $(seq 1 100))
check "an over-long x-correlation-id is not a 5xx" yes "$(s=$(curl -s -m 15 -o /dev/null -w '%{http_code}' -H "x-correlation-id: $LONG_ID" -H 'content-type: application/json' --data '{"email":"probe@example.com","password":"a perfectly fine passphrase"}' "$GW/auth/login"); [ "$s" -lt 500 ] && echo yes || echo "no ($s)")"
check "  identity still answers the next request" yes "$(s=$(curl -s -m 15 -o /dev/null -w '%{http_code}' -H 'content-type: application/json' --data '{"email":"probe2@example.com","password":"a perfectly fine passphrase"}' "$GW/auth/login"); [ "$s" -lt 500 ] && echo yes || echo "no ($s)")"
check "  nothing left unacknowledged on identity.rpc" 0 "$(docker exec "$MQ" rabbitmqctl list_queues name messages_unacknowledged 2> /dev/null | awk '$1 == "identity.rpc" {print $2}')"
BRUTE="brute-$(date +%s)@example.com"
ATTEMPTS=$(for i in $(seq 1 6); do curl -s -o /dev/null -w '%{http_code} ' -H 'content-type: application/json' --data "{\"email\":\"$BRUTE\",\"password\":\"wrong guess number $i\"}" "$GW/auth/login"; done)
check "the sixth wrong password on one address is throttled" 429 "$(echo "$ATTEMPTS" | awk '{print $6}')"

echo "== docs"
check "GET /docs (Swagger UI)" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$GW/docs")"
check "GET /docs/json" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$GW/docs/json")"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
