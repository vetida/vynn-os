#!/usr/bin/env bash
# Regenerate public/index.html from the raw prototype body + head + server adapter.
# Run only if you edit _source-body.html.  Usage:  bash build.sh
set -euo pipefail
cd "$(dirname "$0")"

awk '
$0=="function save(){try{localStorage.setItem(LS,JSON.stringify(state));}catch(e){}}"{
  print "function save(){try{localStorage.setItem(LS,JSON.stringify(state));}catch(e){}if(window.__serverSaveDebounced)window.__serverSaveDebounced();}"; next }
$0=="load();initChrome();render();"{ print "/* boot handled by server persistence adapter (see bottom of file) */"; next }
{ print }
' _source-body.html > _body.patched.html

cat _head.html _body.patched.html _adapter.html > public/index.html
rm -f _body.patched.html
echo "built public/index.html ($(wc -c < public/index.html) bytes)"
