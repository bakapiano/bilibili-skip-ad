#!/usr/bin/env bash
set -euo pipefail
umask 077
stamp=${1:?timestamp required}
expected=${2:?archive SHA256 required}
[[ $EUID -eq 0 && $stamp =~ ^[0-9]{8}-[0-9]{6}$ && $expected =~ ^[a-f0-9]{64}$ ]]
root=/srv/biliskipad
prefix="/tmp/biliskip-asr-resources-$stamp"
target="$root/asr/sherpa-onnx-1.12.20"
backup="$root/backups/asr-resources-$stamp"
config=/etc/nginx/conf.d/biliskipad.conf
wasm_sha=2fc8dc389b23ad07f0d526b2e7c7c828543956d053db858d73cff192be7589e3
support_sha=aee057370c3af9b75689b0f1194428185d0bb0a63314711a73c7bb5f80aef2de
[[ -f $root/.biliskip-managed && -L $root/current ]]
[[ -f $prefix.tar.gz && ! -L $prefix.tar.gz && -f $prefix.nginx && ! -L $prefix.nginx ]]
grep -q '^# Managed by BiliSkip deployment\.' "$config"
printf '%s  %s\n' "$expected" "$prefix.tar.gz" | sha256sum --check -
while IFS= read -r entry; do
    case "$entry" in
        runtime.wasm|support.bin|NOTICE.md|LICENSE|ONNXRUNTIME-LICENSE|ONNXRUNTIME-NOTICES|SILERO-LICENSE|FUNASR-MODEL-LICENSE|provenance.json) ;;
        *) echo 'Unexpected resource archive entry.' >&2; exit 1 ;;
    esac
done < <(tar -tzf "$prefix.tar.gz")
exec 9>"$root/deploy.lock"
flock -n 9
[[ ! -e $backup && ! -L $root/asr && ! -L $target ]]
install -d -m 0700 "$backup" "$backup/staging"
tar -xzf "$prefix.tar.gz" --no-same-owner --no-same-permissions -C "$backup/staging"
[[ $(stat -c %s "$backup/staging/runtime.wasm") == 11539169 ]]
[[ $(stat -c %s "$backup/staging/support.bin") == 959748 ]]
printf '%s  %s\n' "$wasm_sha" "$backup/staging/runtime.wasm" "$support_sha" "$backup/staging/support.bin" | sha256sum --check -
install -d -m 0755 "$root/asr" "$target"
[[ $(realpath "$target") == /srv/biliskipad/asr/sherpa-onnx-1.12.20 ]]
for pair in "runtime.wasm:$wasm_sha.wasm" "support.bin:$support_sha.bin"; do
    source=${pair%%:*}
    destination=${pair#*:}
    if [[ -e $target/$destination ]]; then
        [[ ! -L $target/$destination ]]
        cmp "$backup/staging/$source" "$target/$destination"
    else
        install -m 0644 "$backup/staging/$source" "$target/$destination"
    fi
done
for file in NOTICE.md LICENSE ONNXRUNTIME-LICENSE ONNXRUNTIME-NOTICES SILERO-LICENSE FUNASR-MODEL-LICENSE provenance.json; do
    [[ ! -L $target/$file ]]
    install -m 0644 "$backup/staging/$file" "$target/$file"
done
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
base="https://$domain/asr/sherpa-onnx-1.12.20"
for pair in "$wasm_sha:wasm" "$support_sha:bin"; do
    digest=${pair%%:*}
    suffix=${pair#*:}
    ready=0
    for attempt in $(seq 1 15); do
        if curl --noproxy '*' --resolve "$domain:443:127.0.0.1" -fsS --max-time 15 "$base/$digest.$suffix" -o "$backup/verified.$suffix"; then
            ready=1
            break
        fi
        sleep 1
    done
    [[ $ready -eq 1 ]]
    printf '%s  %s\n' "$digest" "$backup/verified.$suffix" | sha256sum --check -
done
curl --noproxy '*' --resolve "$domain:443:127.0.0.1" -fsS --max-time 5 "https://$domain/healthz"
printf '\nASR resources: %s\nNginx backup: %s\n' "$base" "$backup/nginx.conf"
trap - EXIT
