#!/usr/bin/env python3
"""Stage a signed Android release for the Ulemi update channel (no signing keys)."""
import argparse, hashlib, json, os, re, shutil, subprocess, urllib.request
from pathlib import Path
HOST = 'https://ulemi-updates.pages.dev'
CERT = '256b28dbc27a5898062d699beca788bad60988c7e6bb2edbbc89564e7d696d40'
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('apk', type=Path)
p.add_argument('--output', type=Path, required=True)
p.add_argument('--build-tools', type=Path, required=True)
p.add_argument('--notes', default='Improvements and fixes.')
a = p.parse_args()
if not a.apk.is_file() or a.apk.stat().st_size > 25*1024*1024: raise SystemExit('APK missing or exceeds the Pages asset limit')
cert = subprocess.check_output([str(a.build_tools/'apksigner'),'verify','--verbose','--print-certs',str(a.apk)],text=True)
certs = re.findall(r'Signer #\d+ certificate SHA-256 digest: ([a-f0-9]+)',cert)
if certs != [CERT]: raise SystemExit('APK must use the existing Ulemi release signing identity')
meta = subprocess.check_output([str(a.build_tools/'aapt'),'dump','badging',str(a.apk)],text=True)
m = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'",meta)
if not m or m[1] != 'com.stonezhang.liveui': raise SystemExit('Unexpected APK package')
version, name = int(m[2]), m[3]
if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',name): raise SystemExit('Release version must be x.y.z')
min_sdk = int(re.search(r"sdkVersion:'(\d+)'",meta)[1])
body = a.apk.read_bytes(); digest=hashlib.sha256(body).hexdigest()
# Fail closed on outages; a missing first manifest is the only bootstrap exception.
try:
    with urllib.request.urlopen(HOST+'/android/latest.json',timeout=45) as r: old=json.load(r)
except urllib.error.HTTPError as e:
    if e.code != 404: raise
    old=None
if old:
    if old['versionCode'] > version: raise SystemExit('Refusing to replace a newer update')
    if old['versionCode'] == version and old['sha256'] != digest: raise SystemExit('Version code already published with different bytes')
if len(a.notes)>2000: raise SystemExit('Release notes too long')
release=f'android/releases/Ulemi-{name}-{version}.apk'
a.output.mkdir(parents=True,exist_ok=True)
# A fresh deployment must retain any still-advertised previous release.
if old and old.get('url') != HOST+'/'+release:
    previous=old['url']
    if not previous.startswith(HOST+'/android/releases/') or '..' in previous: raise SystemExit('Unexpected prior release URL')
    dest=a.output/previous.removeprefix(HOST+'/'); dest.parent.mkdir(parents=True,exist_ok=True)
    if not dest.exists() or hashlib.sha256(dest.read_bytes()).hexdigest()!=old['sha256']:
        with urllib.request.urlopen(previous,timeout=120) as r: previous_bytes=r.read(25*1024*1024+1)
        if len(previous_bytes)!=old['size'] or hashlib.sha256(previous_bytes).hexdigest()!=old['sha256']: raise SystemExit('Prior artifact verification failed')
        dest.write_bytes(previous_bytes)
dest=a.output/release; dest.parent.mkdir(parents=True,exist_ok=True); dest.write_bytes(body)
manifest={'schemaVersion':1,'packageName':m[1],'versionCode':version,'versionName':name,'minSdk':min_sdk,'url':HOST+'/'+release,'sha256':digest,'size':len(body),'notes':a.notes}
(a.output/'android/latest.json').write_text(json.dumps(manifest,indent=2)+'\n')
(a.output/'_headers').write_text('/android/latest.json\n  Cache-Control: no-store, max-age=0\n  Content-Type: application/json\n/android/releases/*\n  Cache-Control: public, max-age=31536000, immutable\n  Content-Type: application/vnd.android.package-archive\n/*\n  X-Content-Type-Options: nosniff\n')
(a.output/'index.html').write_text('<!doctype html><meta charset="utf-8"><title>Ulemi updates</title><h1>Ulemi</h1><p>Android updates</p><a href="/'+release+'">Download Ulemi '+name+'</a>')
print(json.dumps(manifest,indent=2))
