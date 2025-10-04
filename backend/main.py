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
# Initialize the Firestore client. This is done globally so that it can be
# reused across function invocations, which is a performance best practice.
db = firestore.Client()

# --- Helper Functions for Analysis ---

def get_dynamic_html_with_selenium(url):
    """
    Uses a headless Chrome browser in the GCP environment to fully render a page.
    This is the core of our dynamic analysis.
    """
    print(f"Starting Selenium for URL: {url}")
    chrome_options = Options()
    # These arguments are essential for running Chrome in a serverless environment.
    chrome_options.add_argument("--headless")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    
    # In the GCP environment, we don't need webdriver-manager. The system knows
    # where to find the pre-installed chromedriver. This is much simpler!
    driver = webdriver.Chrome(options=chrome_options)
    
    html = ""
    try:
        driver.get(url)
        # Wait a few seconds to allow JavaScript to load dynamic content.
        time.sleep(5) 
        html = driver.page_source
        print("Successfully captured dynamic HTML.")
    finally:
        # It's crucial to always quit the driver to free up resources.
        driver.quit()
        
    return html

def get_unique_assets(base_url, soup):
    """
    Parses the HTML soup to find all unique assets (images, scripts, etc.)
    and categorizes them, returning a list of asset dictionaries.
    """
    assets = {} # Using a dictionary keyed by URL prevents duplicates.
    
    # Process various tags to find asset URLs.
    for tag in soup.find_all(['link', 'script', 'img', 'iframe']):
        url = tag.get('href') or tag.get('src')
        if url:
            # Determine asset type based on the tag or file extension.
            asset_type = 'Unknown'
            tag_name = tag.name
            if tag_name == 'link' and 'stylesheet' in tag.get('rel', []):
                asset_type = 'Stylesheet'
            elif tag_name == 'script':
                asset_type = 'Script'
            elif tag_name == 'img':
                asset_type = 'Image'
            elif tag_name == 'iframe':
                asset_type = 'iFrame'
            
            absolute_url = urljoin(base_url, url)
            assets[absolute_url] = {'type': asset_type}

    # Add the base HTML document itself to our analysis.
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
    if not ip_address:
        return None
    try:
        # This free API is great for testing. For a production app, you might use a paid service.
        response = requests.get(f'http://ip-api.com/json/{ip_address}?fields=status,lat,lon,city,country,org')
        response.raise_for_status()
        data = response.json()
        if data and data.get('status') == 'success':
            return {
                "lat": data.get('lat'),
                "lon": data.get('lon'),
                "city": data.get('city', 'Unknown City'),
                "country": data.get('country', 'Unknown Country'),
                "isp": data.get('org', 'Unknown ISP')
            }
    except Exception as e:
        print(f"GeoIP lookup failed for {ip_address}: {e}")
        return None

# --- Main Cloud Function Entrypoint ---

@functions_framework.http
def analyze_supply_chain(request):
    """
    An HTTP-triggered Cloud Function that analyzes the content supply chain of a given URL.
    This is the main function that will be deployed.
    """
    # Set CORS headers to allow requests from any origin. This is crucial for our
    # frontend JavaScript to be able to call this function.
    headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    }
    if request.method == 'OPTIONS':
        return ('', 204, headers)

    # Get the URL from the POST request body.
    request_json = request.get_json(silent=True)
    if not request_json or 'url' not in request_json:
        return (jsonify({"error": "Invalid request. 'url' parameter is required."}), 400, headers)
    
    target_url = request_json['url']
    
    # Create a unique ID for this analysis to track it in Firestore.
    analysis_id = str(uuid.uuid4())
    doc_ref = db.collection('analyses').document(analysis_id)
    doc_ref.set({"status": "starting", "target_url": target_url, "locations": []})

    print(f"Starting analysis {analysis_id} for URL: {target_url}")

    try:
        # --- The Core Analysis Pipeline ---
        final_html = get_dynamic_html_with_selenium(target_url)
        soup = BeautifulSoup(final_html, 'html.parser')
        unique_assets = get_unique_assets(target_url, soup)
        
        doc_ref.update({"status": f"found_{len(unique_assets)}_assets"})

        domains_to_analyze = {asset['domain'] for asset in unique_assets}
        unique_ips = set()

        for domain in domains_to_analyze:
            ip = get_ip_from_domain(domain)
            if ip and ip not in unique_ips:
                unique_ips.add(ip)
                location = get_geolocation(ip)
                if location:
                    # This is the key for real-time updates!
                    # We add the new location to an array in the Firestore document.
                    # Our frontend will be listening for changes to this array.
                    location_data = {
                        "domain": domain,
                        "ip": ip,
                        "city": location['city'],
                        "country": location['country'],
                        "lat": location['lat'],
                        "lon": location['lon'],
                        "isp": location['isp']
                    }
                    doc_ref.update({"locations": firestore.ArrayUnion([location_data])})
        
        doc_ref.update({"status": "completed"})
        print(f"Analysis {analysis_id} completed successfully.")
        
        # Return the analysis ID so the frontend knows which document to listen to.
        return (jsonify({"analysis_id": analysis_id}), 200, headers)

    except Exception as e:
        print(f"An error occurred during analysis {analysis_id}: {e}")
        doc_ref.update({"status": "error", "error_message": str(e)})
        return (jsonify({"error": "An internal error occurred."}), 500, headers)

