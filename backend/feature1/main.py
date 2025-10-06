import functions_framework
from flask import request, jsonify
from google.cloud import firestore
import os
import json
from concurrent.futures import ThreadPoolExecutor

import requests
from bs4 import BeautifulSoup
from urllib.parse import urlparse, urljoin
import dns.resolver
import uuid
import time
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

# --- Globals and Initialization ---
db = firestore.Client()
GLOBAL_DNS_SERVERS = { "Google (USA)": "8.8.8.8", "Cloudflare (USA)": "1.1.1.1", "Quad9 (Switzerland)": "9.9.9.9", "OpenDNS (USA)": "208.67.222.222", "Comodo (USA)": "8.26.56.26", "Yandex (Russia)": "77.88.8.8", "DNS.WATCH (Germany)": "84.200.69.80", "Level3 (USA)": "4.2.2.1", "Neustar (USA)": "156.154.70.1", "AdGuard (Cyprus)": "94.140.14.14" }

# --- UPGRADE: Reverting to a more robust waiting strategy ---
def get_dynamic_html_and_performance_logs(url):
    """
    UPGRADE: Reverted to a longer, fixed time.sleep() to ensure all third-party
    scripts have ample time to load on complex pages. This fixes the data regression.
    """
    print(f"Starting Selenium with Performance Logging for URL: {url}")
    chrome_options = Options()
    chrome_options.add_argument("--headless")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36"
    chrome_options.add_argument(f'user-agent={user_agent}')
    chrome_options.set_capability('goog:loggingPrefs', {'performance': 'ALL'})
    
    driver = webdriver.Chrome(options=chrome_options)
    html = ""
    logs = []
    try:
        driver.get(url)
        # Reverting to a generous 10-second sleep. This is less "efficient" but far
        # more reliable for capturing the full, complex supply chain.
        print("Waiting 10 seconds for dynamic content to load...")
        time.sleep(10) 
        html = driver.page_source
        logs = driver.get_log('performance')
        print("Successfully captured dynamic HTML and performance logs.")
    finally:
        driver.quit()
    return html, logs

# (The rest of the backend file remains the same as it's already correct)
def process_performance_logs(logs):
    asset_timings = {}
    for entry in logs:
        log = json.loads(entry['message'])['message']
        if 'Network.responseReceived' == log['method']:
            params = log['params']
            url = params['response']['url']
            timestamp = params['timestamp'] * 1000 
            asset_timings[url] = {'load_start_time': timestamp}
    return asset_timings

def get_unique_assets(base_url, soup):
    assets = {}
    for tag in soup.find_all(['link', 'script', 'img', 'iframe', 'source']):
        url = tag.get('href') or tag.get('src')
        if url and not url.startswith('data:'):
            asset_type, tag_name = 'Unknown', tag.name
            if tag_name == 'link' and 'stylesheet' in tag.get('rel', []): asset_type = 'Stylesheet'
            elif tag_name == 'script': asset_type = 'Script'
            elif tag_name in ['img', 'source']: asset_type = 'Image/Media'
            elif tag_name == 'iframe': asset_type = 'iFrame'
            assets[urljoin(base_url, url)] = {'type': asset_type}
    assets[base_url] = {'type': 'HTML Document'}
    asset_list = [{'url': url, 'domain': urlparse(url).netloc, 'type': data['type']} for url, data in assets.items() if urlparse(url).netloc]
    return asset_list

def get_ip_from_domain(domain):
    try: return str(dns.resolver.resolve(domain, 'A')[0])
    except Exception: return None

def get_geolocation(ip_address):
    if not ip_address: return None
    try:
        response = requests.get(f'http://ip-api.com/json/{ip_address}?fields=status,lat,lon,city,country,org')
        response.raise_for_status()
        data = response.json()
        if data and data.get('status') == 'success':
            return {"lat": data.get('lat'), "lon": data.get('lon'), "city": data.get('city', 'Unknown'), "country": data.get('country', 'Unknown'), "isp": data.get('org', 'Unknown')}
    except Exception: return None

def analyze_supply_chain_and_journey(target_url, doc_ref):
    print(f"Starting Task A: Supply Chain/Journey for {target_url}")
    final_html, logs = get_dynamic_html_and_performance_logs(target_url)
    asset_timings = process_performance_logs(logs)
    soup = BeautifulSoup(final_html, 'html.parser')
    unique_assets = get_unique_assets(target_url, soup)
    doc_ref.update({"status_supply_chain": f"found_{len(unique_assets)}_assets"})
    domain_cache = {}
    for asset in unique_assets:
        domain = asset['domain']
        enriched_data = domain_cache.get(domain)
        if not enriched_data:
            ip = get_ip_from_domain(domain)
            if ip: enriched_data = {"ip": ip, **(get_geolocation(ip) or {})}
            domain_cache[domain] = enriched_data
        if enriched_data:
            asset_payload = {**asset, **enriched_data}
            timing = asset_timings.get(asset['url'])
            if timing: asset_payload.update(timing)
            doc_ref.update({"assets": firestore.ArrayUnion([asset_payload])})
    doc_ref.update({"status_supply_chain": "completed"})
    print("Task A: Supply Chain/Journey COMPLETED")

def analyze_dns_latency(target_domain, doc_ref):
    print(f"Starting Task B: DNS Latency for {target_domain}")
    doc_ref.update({"status_dns_latency": "running"})
    def measure_latency(resolver_name, resolver_ip):
        try:
            resolver = dns.resolver.Resolver(); resolver.nameservers = [resolver_ip]
            start_time = time.time()
            resolver.resolve(target_domain, 'A'); end_time = time.time()
            latency_ms = (end_time - start_time) * 1000
            result = {"resolver_name": resolver_name, "latency_ms": latency_ms}
            doc_ref.update({"dns_latency_results": firestore.ArrayUnion([result])})
        except Exception as e: print(f"DNS latency test failed for {resolver_name}: {e}")
    with ThreadPoolExecutor(max_workers=len(GLOBAL_DNS_SERVERS)) as executor:
        for name, ip in GLOBAL_DNS_SERVERS.items(): executor.submit(measure_latency, name, ip)
    doc_ref.update({"status_dns_latency": "completed"})
    print("Task B: DNS Latency COMPLETED")

@functions_framework.http
def analyze_web_footprint(request):
    headers = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type'}
    if request.method == 'OPTIONS': return ('', 204, headers)
    request_json = request.get_json(silent=True)
    if not request_json or 'url' not in request_json: return (jsonify({"error": "Invalid request. 'url' is required."}), 400, headers)
    target_url = request_json['url']; target_domain = urlparse(target_url).netloc
    analysis_id = str(uuid.uuid4())
    doc_ref = db.collection('analyses').document(analysis_id)
    doc_ref.set({"status": "starting", "target_url": target_url, "assets": [], "dns_latency_results": []})
    print(f"Starting orchestrated analysis {analysis_id} for URL: {target_url}")
    with ThreadPoolExecutor(max_workers=2) as executor:
        executor.submit(analyze_supply_chain_and_journey, target_url, doc_ref)
        executor.submit(analyze_dns_latency, target_domain, doc_ref)
    return (jsonify({"analysis_id": analysis_id}), 200, headers)

