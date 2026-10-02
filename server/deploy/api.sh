#!/usr/bin/env bash
# Scoped API/schema/privacy release. Existing homepage, model resources and downloads are preserved.
set -euo pipefail
umask 077
root=/srv/biliskipad
bundle=${1:?bundle}
expected_sha=${2:?sha256}
release_id=${3:?release}
expected_previous=${4:?previous release}
[[ $EUID -eq 0 && $release_id =~ ^[0-9]{8}-[0-9]{6}-[a-f0-9]{12}$ ]]
[[ $expected_sha =~ ^[a-f0-9]{64}$ && $bundle == "/tmp/biliskipad-api-$release_id.tar.gz" ]]
[[ $expected_previous =~ ^/srv/biliskipad/releases/[0-9]{8}-[0-9]{6}-[a-f0-9]{12}$ ]]
[[ -f $root/.biliskip-managed && -L $root/current && -f $bundle && ! -L $bundle ]]
printf '%s  %s\n' "$expected_sha" "$bundle" | sha256sum --check -
exec 9>"$root/deploy.lock"
flock -n 9
previous=$(readlink -f "$root/current")
[[ $previous == "$expected_previous" ]]
release_dir="$root/releases/$release_id"
backup_dir="$root/backups/api-$release_id"
next_link="$root/current-$release_id.next"
[[ ! -e $release_dir && ! -e $backup_dir && ! -e $next_link && ! -L $next_link ]]
while IFS= read -r file; do
    case "$file" in
        server/app.js|server/badges.js|server/config.js|server/healthcheck.js|server/index.js|server/store.js|server/validation.js|server/deploy/nginx.conf|server/site/privacy.html) ;;
        *) echo "Unexpected archive path: $file" >&2; exit 1 ;;
    esac
done < <(tar -tzf "$bundle")
snapshot="/data/backups/pre-$release_id.sqlite"
docker compose -p biliskipad -f "$root/compose.yaml" exec -T -e BILISKIP_BACKUP="$snapshot" api node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, access } from 'node:fs/promises';
const target = process.env.BILISKIP_BACKUP;
assert.match(target, /^\/data\/backups\/pre-[0-9]{8}-[0-9]{6}-[a-f0-9]{12}\.sqlite$/);
await mkdir('/data/backups', { recursive: true, mode: 0o700 });
await assert.rejects(access(target), { code: 'ENOENT' });
const source = new DatabaseSync('/data/shared-cache.sqlite', { readOnly: true });
try { await backup(source, target); } finally { source.close(); }
const db = new DatabaseSync(target, { readOnly: true });
try {
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  console.log(JSON.stringify({ backup: target, records: db.prepare('SELECT COUNT(*) AS count FROM records').get().count, integrity: 'ok' }));
} finally { db.close(); }
JS
mkdir -m 0700 "$backup_dir"
cp -p /etc/nginx/conf.d/biliskipad.conf "$backup_dir/nginx.conf"
cp -a -- "$previous" "$release_dir"
tar -xzf "$bundle" --no-same-owner --no-same-permissions -C "$release_dir"
# Render only the privacy page while retaining the existing public download version and CSS identity.
site_version=$(sed -n 's/.*本站 ZIP \([0-9.]*\).*/\1/p' "$previous/site/privacy.html" | head -n 1)
css_version=$(sed -n 's/.*site.css?v=\([a-f0-9]*\).*/\1/p' "$previous/site/privacy.html" | head -n 1)
[[ $site_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && $css_version =~ ^[a-f0-9]+$ ]]
sed -e "s/{{VERSION}}/$site_version/g" -e "s/{{ASSET_VERSION}}/$css_version/g" "$release_dir/server/site/privacy.html" > "$release_dir/site/privacy.html"
chmod 0644 "$release_dir/site/privacy.html" "$release_dir/server/"*.js
diff -qr "$previous/site/downloads" "$release_dir/site/downloads"
cmp "$previous/site/index.html" "$release_dir/site/index.html"
changed=0
nginx_changed=0
rollback() {
    status=$?
    trap - EXIT
    if [[ $status -ne 0 ]]; then
        if [[ $changed -eq 1 ]]; then
            ln -s "$previous" "$next_link"
            mv -Tf -- "$next_link" "$root/current"
            docker compose -p biliskipad -f "$root/compose.yaml" up -d --force-recreate api
        fi
        if [[ $nginx_changed -eq 1 ]]; then
            install -m 0644 "$backup_dir/nginx.conf" /etc/nginx/conf.d/biliskipad.conf
            nginx -t && systemctl reload nginx
        fi
    fi
    exit "$status"
}
trap rollback EXIT
ln -s "$release_dir" "$next_link"
mv -Tf -- "$next_link" "$root/current"
changed=1
docker compose -p biliskipad -f "$root/compose.yaml" up -d --force-recreate api
nginx_changed=1
install -m 0644 "$release_dir/server/deploy/nginx.conf" /etc/nginx/conf.d/biliskipad.conf
nginx -t
systemctl reload nginx
healthy=0
for attempt in $(seq 1 30); do
    if curl --noproxy '*' -fsS --max-time 2 http://127.0.0.1:8787/healthz >/dev/null; then healthy=1; break; fi
    sleep 1
done
[[ $healthy -eq 1 ]]
docker compose -p biliskipad -f "$root/compose.yaml" exec -T -e BILISKIP_BACKUP="$snapshot" api node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { validateQuery } from './server/validation.js';
const key = validateQuery(new URLSearchParams({ bvid: 'BV1pFUDBKE8X', page: 1, cid: 34253507696, transcript_sha256: '0'.repeat(64), model: 'deepseek-flash', prompt_version: 'ad-cues-v6-json' }));
assert.ok(key.endsWith('ad-cues-v6-json'));
const db = new DatabaseSync('/data/shared-cache.sqlite', { readOnly: true });
try {
  db.prepare('ATTACH DATABASE ? AS snapshot').run(process.env.BILISKIP_BACKUP);
  const changed = db.prepare(`SELECT COUNT(*) AS count FROM snapshot.records s LEFT JOIN main.records c ON c.cache_key = s.cache_key WHERE c.cache_key IS NULL OR c.payload <> s.payload OR c.active <> s.active OR c.id <> s.id OR c.request_hash <> s.request_hash OR c.created_at <> s.created_at`).get().count;
  assert.equal(changed, 0);
  const count = db.prepare('SELECT COUNT(*) AS count FROM transcripts').get().count;
  console.log(JSON.stringify({ recordsPreserved: true, transcriptTable: true, transcripts: count, promptV6: true }));
} finally { db.close(); }
JS
curl --noproxy '*' -fsS --max-time 5 --resolve biliskipad.bakapiano.com:443:127.0.0.1 https://biliskipad.bakapiano.com/healthz
for metric in videos segments saved-time; do
    curl --noproxy '*' -fsS --max-time 5 --resolve biliskipad.bakapiano.com:443:127.0.0.1 "https://biliskipad.bakapiano.com/v1/badges/$metric" |
        grep -q '"schemaVersion":1'
done
printf '\nRelease: %s\nBackup: %s\n' "$release_id" "$snapshot"
trap - EXIT
