#!/usr/bin/env bash
set -euo pipefail
umask 077
stamp=${1:?timestamp required}
[[ $EUID -eq 0 && $stamp =~ ^[0-9]{8}-[0-9]{6}$ ]]
root=/srv/biliskipad
prefix="/tmp/biliskip-model-$stamp"
sha=c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51
target="$root/models/sensevoice-small-int8"
config=/etc/nginx/conf.d/biliskipad.conf
[[ -f $root/.biliskip-managed && -L $root/current ]]
grep -q '^# Managed by BiliSkip deployment\.' "$config"
for suffix in onnx nginx license notice; do [[ -f $prefix.$suffix && ! -L $prefix.$suffix ]]; done
[[ $(stat -c %s "$prefix.onnx") == 239233841 ]]
printf '%s  %s\n' "$sha" "$prefix.onnx" | sha256sum --check -
exec 9>"$root/deploy.lock"
flock -n 9
[[ ! -L $root/models && ! -L $target ]]
install -d -m 0755 "$root/models" "$target"
[[ $(realpath "$target") == /srv/biliskipad/models/sensevoice-small-int8 ]]
if [[ -e $target/$sha.onnx ]]; then
    [[ ! -L $target/$sha.onnx ]]
    printf '%s  %s\n' "$sha" "$target/$sha.onnx" | sha256sum --check -
else
    install -m 0644 "$prefix.onnx" "$target/$sha.onnx"
fi
install -m 0644 "$prefix.license" "$target/LICENSE"
install -m 0644 "$prefix.notice" "$target/NOTICE.md"
backup="$root/backups/model-$stamp"
[[ ! -e $backup ]]
install -d -m 0700 "$backup"
cp -p "$config" "$backup/nginx.conf"
changed=0
rollback() {
    status=$?
    trap - EXIT
    if [[ $status -ne 0 && $changed -eq 1 ]]; then
        install -m 0644 "$backup/nginx.conf" "$config"
        nginx -t && systemctl reload nginx
        echo 'Restored previous BiliSkip Nginx configuration.' >&2
    fi
    exit "$status"
}
trap rollback EXIT
install -m 0644 "$prefix.nginx" "$config"
changed=1
nginx -t
systemctl reload nginx
domain=biliskipad.bakapiano.com
url="https://$domain/models/sensevoice-small-int8/$sha.onnx"
ready=0
for attempt in $(seq 1 15); do
    if curl --noproxy '*' --resolve "$domain:443:127.0.0.1" -fsSI --max-time 3 "$url" >"$backup/model-headers.txt"; then
        ready=1
        break
    fi
    sleep 1
done
[[ $ready -eq 1 ]]
grep -qi 'Content-Length: 239233841' "$backup/model-headers.txt"
curl --noproxy '*' --resolve "$domain:443:127.0.0.1" -fsS --max-time 5 --range 0-1023 "$url" -o "$backup/model-range.bin"
[[ $(stat -c %s "$backup/model-range.bin") == 1024 ]]
curl --noproxy '*' --resolve "$domain:443:127.0.0.1" -fsS --max-time 5 "https://$domain/healthz"
printf '\nModel: %s\nBytes: 239233841\nNginx backup: %s\n' "$url" "$backup/nginx.conf"
trap - EXIT
