#!/usr/bin/env bash
set -euo pipefail
umask 077

bundle=${1:?bundle path required}
expected_sha=${2:?bundle SHA256 required}
release_id=${3:?release id required}
app_root=/srv/biliskipad
nginx_conf=/etc/nginx/conf.d/biliskipad.conf
domain=biliskipad.bakapiano.com
image=node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

[[ $EUID -eq 0 ]] || { echo 'Run deployment as root.' >&2; exit 1; }
[[ $release_id =~ ^[0-9]{8}-[0-9]{6}-[a-f0-9]{12}$ ]] || exit 1
[[ $expected_sha =~ ^[a-f0-9]{64}$ ]] || exit 1
[[ $bundle == "/tmp/biliskipad-$release_id.tar.gz" ]] || exit 1
for tool in docker nginx curl openssl tar sha256sum flock; do command -v "$tool" >/dev/null; done
[[ -x /root/.acme.sh/acme.sh ]] || { echo 'Existing acme.sh installation required.' >&2; exit 1; }
if [[ -e $app_root && ! -f $app_root/.biliskip-managed ]]; then
    echo 'Deployment directory exists without the BiliSkip ownership marker.' >&2
    exit 1
fi
if [[ -e $nginx_conf ]] && ! grep -q '^# Managed by BiliSkip deployment\.' "$nginx_conf"; then
    echo 'Existing virtual host is not managed by BiliSkip.' >&2
    exit 1
fi
printf '%s  %s\n' "$expected_sha" "$bundle" | sha256sum --check -
while IFS= read -r entry; do
    case "$entry" in
        LICENSE|package.json|server/*.js|server/deploy/compose.yaml|server/deploy/nginx.conf|server/deploy/nginx-http.conf) ;;
        site/index.html|site/privacy.html|site/site.css|site/stats.js|site/assets/site-icon.svg|site/assets/github.svg|site/assets/navigation.js|site/assets/icon.png|site/assets/ad-markers.png|site/assets/auto-skip.png|site/assets/pet-bubble.jpg|site/assets/pet-player.jpg|site/assets/pet-settings.jpg|site/downloads/biliskip-*.zip|site/downloads/biliskip-*.zip.sha256) ;;
        site/downloads/biliskip.zip|site/downloads/biliskip.zip.sha256) ;;
        *) echo "Unexpected archive entry: $entry" >&2; exit 1 ;;
    esac
    [[ $entry != /* && $entry != *../* ]] || exit 1
done < <(tar -tzf "$bundle")

install -d -m 0755 "$app_root" "$app_root/releases"
touch "$app_root/.biliskip-managed"
exec 9>"$app_root/deploy.lock"
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }
release_dir="$app_root/releases/$release_id"
[[ ! -e $release_dir ]] || { echo 'Release directory already exists; create a new release.' >&2; exit 1; }
install -d -m 0755 "$release_dir"
tar -xzf "$bundle" --no-same-owner --no-same-permissions -C "$release_dir"
find "$release_dir" -type d -exec chmod 0755 {} +
find "$release_dir" -type f -exec chmod 0644 {} +
install -d -o 1000 -g 1000 -m 0700 "$app_root/data"
install -d -m 0700 "$app_root/backups/$release_id" /etc/biliskipad/tls
install -d -m 0755 /var/lib/biliskipad/acme
if [[ ! -e $app_root/service.env ]]; then install -m 0600 /dev/null "$app_root/service.env"; fi

previous_release=''
if [[ -L $app_root/current ]]; then
    previous_release=$(readlink "$app_root/current")
    [[ $previous_release == "$app_root/releases/"* && -d $previous_release ]] || exit 1
elif [[ -e $app_root/current ]]; then
    echo 'Current release path should be a managed symbolic link.' >&2
    exit 1
fi
# Preserve versioned download links while the new release replaces the stable ZIP.
if [[ -n $previous_release && -d $previous_release/site/downloads ]]; then
    for old_download in "$previous_release/site/downloads"/biliskip-*.zip*; do
        [[ -f $old_download && ! -L $old_download ]] || continue
        download_name=${old_download##*/}
        [[ $download_name =~ ^biliskip-[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?\.zip(\.sha256)?$ ]] || continue
        if [[ ! -e $release_dir/site/downloads/$download_name ]]; then
            cp -p -- "$old_download" "$release_dir/site/downloads/$download_name"
        fi
    done
fi
backup_dir="$app_root/backups/$release_id"
if [[ -z $previous_release ]] && [[ -n $(ss -H -lnt 'sport = :8787') ]]; then
    echo 'Port 8787 is already occupied; inspect the existing listener first.' >&2
    exit 1
fi
if [[ -f $app_root/compose.yaml ]]; then cp -p "$app_root/compose.yaml" "$backup_dir/compose.yaml"; fi
if [[ -f $nginx_conf ]]; then cp -p "$nginx_conf" "$backup_dir/nginx.conf"; fi
app_changed=0
nginx_changed=0

rollback() {
    status=$?
    trap - EXIT
    if [[ $status -ne 0 ]]; then
        echo 'Deployment failed; restoring the previous BiliSkip release and virtual host.' >&2
        set +e
        if [[ $app_changed -eq 1 ]]; then
            if [[ -n $previous_release && -f $backup_dir/compose.yaml ]]; then
                ln -sfn "$previous_release" "$app_root/current.next"
                mv -Tf "$app_root/current.next" "$app_root/current"
                install -m 0644 "$backup_dir/compose.yaml" "$app_root/compose.yaml"
                docker compose -p biliskipad -f "$app_root/compose.yaml" up -d --force-recreate api
            else
                docker compose -p biliskipad -f "$app_root/compose.yaml" stop api
            fi
        fi
        if [[ $nginx_changed -eq 1 ]]; then
            if [[ -f $backup_dir/nginx.conf ]]; then
                install -m 0644 "$backup_dir/nginx.conf" "$nginx_conf"
            elif [[ -f $nginx_conf ]] && grep -q '^# Managed by BiliSkip deployment\.' "$nginx_conf"; then
                rm -- "$nginx_conf"
            fi
            nginx -t && systemctl reload nginx
        fi
    fi
    exit "$status"
}
trap rollback EXIT

docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image"
app_changed=1
ln -sfn "$release_dir" "$app_root/current.next"
mv -Tf "$app_root/current.next" "$app_root/current"
install -m 0644 "$release_dir/server/deploy/compose.yaml" "$app_root/compose.yaml"
docker compose -p biliskipad -f "$app_root/compose.yaml" config --quiet
docker compose -p biliskipad -f "$app_root/compose.yaml" up -d --force-recreate api
healthy=0
for attempt in $(seq 1 30); do
    if curl --noproxy '*' -fsS --max-time 3 http://127.0.0.1:8787/healthz >/dev/null 2>&1; then healthy=1; break; fi
    sleep 1
done
[[ $healthy -eq 1 ]] || { echo 'Application health check failed.' >&2; exit 1; }
curl --noproxy '*' -fsS --max-time 5 http://127.0.0.1:8787/v1/stats |
    grep -q '"basis":"latest-active-per-video-part-ad-duration"' || {
        echo 'Public cache statistics readiness check failed.' >&2
        exit 1
    }

if [[ ! -s /etc/biliskipad/tls/fullchain.pem ]] || ! openssl x509 -checkend 86400 -noout -in /etc/biliskipad/tls/fullchain.pem >/dev/null; then
    nginx_changed=1
    install -m 0644 "$release_dir/server/deploy/nginx-http.conf" "$nginx_conf"
    nginx -t
    systemctl reload nginx
    issue_status=0
    /root/.acme.sh/acme.sh --issue --server letsencrypt --domain "$domain" --webroot /var/lib/biliskipad/acme --keylength ec-256 || issue_status=$?
    [[ $issue_status -eq 0 || $issue_status -eq 2 ]] || exit "$issue_status"
    /root/.acme.sh/acme.sh --install-cert --ecc -d "$domain" \
        --key-file /etc/biliskipad/tls/key.pem \
        --fullchain-file /etc/biliskipad/tls/fullchain.pem \
        --reloadcmd '/usr/sbin/nginx -t && /usr/bin/systemctl reload nginx'
fi
nginx_changed=1
install -m 0644 "$release_dir/server/deploy/nginx.conf" "$nginx_conf"
nginx -t
systemctl reload nginx
tls_ready=0
for attempt in $(seq 1 30); do
    if curl --noproxy '*' -fsS --max-time 3 --resolve "$domain:443:127.0.0.1" "https://$domain/healthz" 2>"$backup_dir/tls-health.stderr"; then
        tls_ready=1
        break
    fi
    sleep 1
done
if [[ $tls_ready -ne 1 ]]; then
    tail -n 8 "$backup_dir/tls-health.stderr" >&2
    echo 'HTTPS health check failed after Nginx reload.' >&2
    exit 1
fi
site_ready=0
for attempt in $(seq 1 20); do
    if curl --noproxy '*' -fsS --max-time 3 --resolve "$domain:443:127.0.0.1" "https://$domain/" -o "$backup_dir/site-check.html" 2>/dev/null && grep -q '<title>BiliSkip' "$backup_dir/site-check.html"; then
        site_ready=1
        break
    fi
    sleep 1
done
[[ $site_ready -eq 1 ]] || { echo 'Landing page readiness check failed.' >&2; exit 1; }
printf '\nRelease: %s\nURL: https://%s\n' "$release_id" "$domain"
docker compose -p biliskipad -f "$app_root/compose.yaml" ps
trap - EXIT
