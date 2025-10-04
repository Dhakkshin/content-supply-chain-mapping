import functions_framework
from flask import request, jsonify
from google.cloud import firestore

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

# --- Helper Functions for Analysis ---

def get_dynamic_html_with_selenium(url):
    """
    Uses a headless Chrome browser to render a page, now with a realistic User-Agent
    to better simulate a real user and avoid basic bot detection.
    """
    print(f"Starting Selenium for URL: {url}")
    chrome_options = Options()
    chrome_options.add_argument("--headless")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    
    # UPGRADE: Adding a standard User-Agent string to appear more like a real browser.
    user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36"
    chrome_options.add_argument(f'user-agent={user_agent}')
    
    driver = webdriver.Chrome(options=chrome_options)
    
    html = ""
    try:
        driver.get(url)
        # Increased sleep time to allow more complex, ad-heavy sites to load.
        time.sleep(7) 
        html = driver.page_source
        print("Successfully captured dynamic HTML.")
    finally:
        driver.quit()
        
    return html

def get_unique_assets(base_url, soup):
    """
    Parses the HTML soup to find all unique assets (images, scripts, etc.)
    and categorizes them, returning a list of asset dictionaries.
    """
    assets = {}
    
    for tag in soup.find_all(['link', 'script', 'img', 'iframe', 'source']):
        url = tag.get('href') or tag.get('src')
        if url and not url.startswith('data:'): # Ignore inline data URIs
            asset_type = 'Unknown'
            tag_name = tag.name
            if tag_name == 'link' and 'stylesheet' in tag.get('rel', []):
                asset_type = 'Stylesheet'
            elif tag_name == 'script':
                asset_type = 'Script'
            elif tag_name in ['img', 'source']:
                asset_type = 'Image/Media'
            elif tag_name == 'iframe':
                asset_type = 'iFrame'
            
            absolute_url = urljoin(base_url, url)
            assets[absolute_url] = {'type': asset_type}

    assets[base_url] = {'type': 'HTML Document'}

    asset_list = []
    for url, data in assets.items():
        domain = urlparse(url).netloc
        if domain:
            asset_list.append({'url': url, 'domain': domain, 'type': data['type']})
            
    return asset_list

def get_ip_from_domain(domain):
    """Converts a domain to an IP address using DNS."""
    try:
        return str(dns.resolver.resolve(domain, 'A')[0])
    except Exception as e:
        print(f"Could not resolve domain {domain}: {e}")
        return None

def get_geolocation(ip_address):
    """Uses a free GeoIP API to find the location of an IP address."""
    if not ip_address: return None
    try:
        response = requests.get(f'http://ip-api.com/json/{ip_address}?fields=status,lat,lon,city,country,org')
        response.raise_for_status()
        data = response.json()
        if data and data.get('status') == 'success':
            return {
                "lat": data.get('lat'), "lon": data.get('lon'),
                "city": data.get('city', 'Unknown'), "country": data.get('country', 'Unknown'),
                "isp": data.get('org', 'Unknown')
            }
    except Exception as e:
        print(f"GeoIP lookup failed for {ip_address}: {e}")
        return None

# --- Main Cloud Function Entrypoint ---

@functions_framework.http
def analyze_supply_chain(request):
    """
    The main HTTP-triggered function. This version has been significantly upgraded
    to provide detailed, asset-level information.
    """
    headers = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type'}
    if request.method == 'OPTIONS': return ('', 204, headers)

    request_json = request.get_json(silent=True)
    if not request_json or 'url' not in request_json:
        return (jsonify({"error": "Invalid request. 'url' is required."}), 400, headers)
    
    target_url = request_json['url']
    analysis_id = str(uuid.uuid4())
    doc_ref = db.collection('analyses').document(analysis_id)
    # NEW STRUCTURE: The document will now contain a list of 'assets'.
    doc_ref.set({"status": "starting", "target_url": target_url, "assets": []})

    print(f"Starting analysis {analysis_id} for URL: {target_url}")

    try:
        final_html = get_dynamic_html_with_selenium(target_url)
        soup = BeautifulSoup(final_html, 'html.parser')
        unique_assets = get_unique_assets(target_url, soup)
        doc_ref.update({"status": f"found_{len(unique_assets)}_assets"})
        
        # This cache is a performance optimization. As a CS student, you'll see
        # it prevents us from repeatedly looking up the location for the same domain.
        domain_location_cache = {}

        for asset in unique_assets:
            domain = asset['domain']
            location_data = None

            if domain in domain_location_cache:
                location_data = domain_location_cache[domain]
            else:
                ip = get_ip_from_domain(domain)
                if ip:
                    location = get_geolocation(ip)
                    if location:
                        location_data = {"ip": ip, **location}
                # Cache the result, even if it's a failure (None), to avoid retrying.
                domain_location_cache[domain] = location_data
            
            if location_data:
                # NEW STRUCTURE: We combine the asset info with its location info
                # and save this rich object to the database.
                asset_payload = {**asset, **location_data}
                doc_ref.update({"assets": firestore.ArrayUnion([asset_payload])})
        
        doc_ref.update({"status": "completed"})
        print(f"Analysis {analysis_id} completed successfully.")
        return (jsonify({"analysis_id": analysis_id}), 200, headers)

    except Exception as e:
        print(f"An error occurred during analysis {analysis_id}: {e}")
        doc_ref.update({"status": "error", "error_message": str(e)})
        return (jsonify({"error": "An internal error occurred."}), 500, headers)

