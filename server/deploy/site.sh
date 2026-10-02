#!/usr/bin/env bash
set -euo pipefail
umask 077
release=${1:?release id}
expected=${2:?archive SHA256}
previous=${3:?previous release}
root=/srv/biliskipad
config=/etc/nginx/conf.d/biliskipad.conf
[[ $EUID -eq 0 && $release =~ ^[0-9]{8}-[0-9]{6}-[a-f0-9]{12}$ && $expected =~ ^[a-f0-9]{64}$ ]]
[[ $previous =~ ^/srv/biliskipad/releases/[0-9]{8}-[0-9]{6}-[a-f0-9]{12}$ ]]
[[ -f $root/.biliskip-managed && -L $root/current && $(readlink -f "$root/current") == "$previous" ]]
grep -q '^# Managed by BiliSkip deployment\.' "$config"
bundle="/tmp/biliskip-site-$release.tar.gz"
printf '%s  %s\n' "$expected" "$bundle" | sha256sum --check -
while IFS= read -r file; do
    case "$file" in
        server/app.js|server/store.js|server/validation.js|server/deploy/nginx.conf) ;;
        site/index.html|site/privacy.html|site/site.css|site/stats.js|site/assets/site-icon.svg|site/assets/icon.png|site/assets/ad-markers.png|site/assets/auto-skip.png) ;;
        *) echo 'Unexpected site archive entry.' >&2; exit 1 ;;
    esac
done < <(tar -tzf "$bundle")
exec 9>"$root/deploy.lock"
flock -n 9
[[ $(readlink -f "$root/current") == "$previous" ]]
destination="$root/releases/$release"
backup="$root/backups/site-$release"
[[ ! -e $destination && ! -e $backup ]]
snapshot="/data/backups/pre-site-$release.sqlite"
docker compose -p biliskipad -f "$root/compose.yaml" exec -T -e SNAPSHOT_PATH="$snapshot" api node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, access, chmod, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const file=process.env.SNAPSHOT_PATH;
assert.match(file, /^\/data\/backups\/pre-site-[0-9]{8}-[0-9]{6}-[a-f0-9]{12}\.sqlite$/);
await mkdir('/data/backups',{recursive:true,mode:0o700});
await assert.rejects(access(file),{code:'ENOENT'});
const source=new DatabaseSync('/data/shared-cache.sqlite',{readOnly:true});
try { await backup(source,file); } finally {source.close();}
await chmod(file,0o600);
const copy=new DatabaseSync(file,{readOnly:true});
try {
  assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  console.log(JSON.stringify({snapshot:file,records:copy.prepare('SELECT COUNT(*) AS count FROM records').get().count,sha256:createHash('sha256').update(await readFile(file)).digest('hex')}));
} finally {copy.close();}
JS
cp -a -- "$previous" "$destination"
tar -xzf "$bundle" --no-same-owner --no-same-permissions -C "$destination"
find "$destination" -type d -exec chmod 0755 {} +
find "$destination" -type f -exec chmod 0644 {} +
cmp "$previous/site/downloads/biliskip.zip" "$destination/site/downloads/biliskip.zip"
install -d -m 0700 "$backup"
cp -p "$config" "$backup/nginx.conf"
# Retire only the two known files in the newly copied release; preserve an exact rollback copy.
for retired in results.html results.js; do
    candidate="$destination/site/$retired"
    [[ ! -L $candidate ]]
    if [[ -f $candidate ]]; then
        [[ $(realpath "$candidate") == "$destination/site/$retired" ]]
        mv -- "$candidate" "$backup/$retired"
    fi
done
next="$root/current-$release.next"
[[ ! -e $next && ! -L $next ]]
changed=0
rollback() {
    status=$?
    trap - EXIT
    if [[ $status -ne 0 && $changed -eq 1 ]]; then
        ln -s "$previous" "$next"
        mv -Tf -- "$next" "$root/current"
        install -m 0644 "$backup/nginx.conf" "$config"
        docker compose -p biliskipad -f "$root/compose.yaml" up -d --force-recreate api
        nginx -t && systemctl reload nginx
        echo 'Restored previous website and API release.' >&2
    fi
    exit "$status"
}
trap rollback EXIT
ln -s "$destination" "$next"
mv -Tf -- "$next" "$root/current"
changed=1
docker compose -p biliskipad -f "$root/compose.yaml" up -d --force-recreate api
healthy=0
for attempt in $(seq 1 25); do
    if curl --noproxy '*' -fsS --max-time 3 'http://127.0.0.1:8787/healthz' >"$backup/health-check.json"; then healthy=1; break; fi
    sleep 1
done
[[ $healthy -eq 1 ]]
install -m 0644 "$destination/server/deploy/nginx.conf" "$config"
nginx -t
systemctl reload nginx
domain=biliskipad.bakapiano.com
ready=0
for attempt in $(seq 1 20); do
    if curl --noproxy '*' --resolve "$domain:443:127.0.0.1" -fsS --max-time 3 "https://$domain/" >"$backup/page-check.html" && ! grep -q '/results.html' "$backup/page-check.html"; then ready=1; break; fi
    sleep 1
done
[[ $ready -eq 1 ]]
grep -q 'class="demo-result"' "$backup/page-check.html"
# Nginx reload is graceful: allow old workers to drain before checking retired locations.
retired_ready=0
for attempt in $(seq 1 20); do
    all_retired=1
    for retired_path in /results /results.html /results.js /v1/results; do
        status=$(curl --noproxy '*' --resolve "$domain:443:127.0.0.1" -sS --max-time 3 -o /dev/null -w '%{http_code}' "https://$domain$retired_path")
        if [[ $status != 404 ]]; then all_retired=0; break; fi
    done
    if [[ $all_retired -eq 1 ]]; then retired_ready=1; break; fi
    sleep 1
done
[[ $retired_ready -eq 1 ]] || { echo "Retired endpoint still exposed: $retired_path ($status)" >&2; exit 1; }
curl --noproxy '*' --resolve "$domain:443:127.0.0.1" -fsS --max-time 5 "https://$domain/healthz"
docker compose -p biliskipad -f "$root/compose.yaml" exec -T -e SNAPSHOT_PATH="$snapshot" api node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
const db=new DatabaseSync('/data/shared-cache.sqlite',{readOnly:true});
try {
 db.prepare('ATTACH DATABASE ? AS snapshot').run(process.env.SNAPSHOT_PATH);
 const changed=db.prepare(`SELECT COUNT(*) AS count FROM snapshot.records old LEFT JOIN main.records current ON old.cache_key=current.cache_key
   WHERE current.cache_key IS NULL OR old.payload<>current.payload OR old.active<>current.active OR old.id<>current.id OR old.created_at<>current.created_at OR old.request_hash<>current.request_hash`).get().count;
 assert.equal(changed,0);console.log(JSON.stringify({originalRecordsChanged:changed,records:db.prepare('SELECT COUNT(*) AS count FROM records').get().count}));
} finally {db.close();}
JS
printf '\nRelease: %s\nSnapshot: %s\n' "$release" "$snapshot"
sha256sum "$destination/site/downloads/biliskip.zip"
docker compose -p biliskipad -f "$root/compose.yaml" ps
trap - EXIT
