import sys
import requests
from bs4 import BeautifulSoup
from urllib.parse import urlparse, urljoin
import dns.resolver
from datetime import datetime
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
import time

# --- Helper Functions (Updated and New) ---

def get_dynamic_html_with_selenium(url):
    """
    Uses a headless Chrome browser to fully render a page, including JS-loaded content.
    Returns the final HTML source code.
    """
    print("  ...launching headless Chrome browser with Selenium...")
    chrome_options = Options()
    chrome_options.add_argument("--headless")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    
    # webdriver_manager will automatically download and manage the correct driver for your Chrome version.
    driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=chrome_options)
    
    driver.get(url)
    # Give the page a few seconds to load dynamic content.
    # A more advanced approach would use "explicit waits," but this is good for a start.
    time.sleep(5) 
    
    html = driver.page_source
    driver.quit()
    print("  ...browser finished, HTML captured.")
    return html

def get_unique_assets(base_url, soup):
    """
    Parses the HTML soup to find all unique assets and categorizes them.
    Returns a list of dictionaries, each representing an asset.
    """
    assets = {} # Use a dictionary to avoid duplicate URLs
    
    # Process link tags (usually for CSS or fonts)
    for tag in soup.find_all('link'):
        url = tag.get('href')
        if url:
            asset_type = 'Stylesheet' if 'stylesheet' in tag.get('rel', []) else 'Other Link'
            absolute_url = urljoin(base_url, url)
            assets[absolute_url] = {'type': asset_type}
            
    # Process script tags
    for tag in soup.find_all('script'):
        url = tag.get('src')
        if url:
            absolute_url = urljoin(base_url, url)
            assets[absolute_url] = {'type': 'Script'}

    # Process image tags
    for tag in soup.find_all('img'):
        url = tag.get('src')
        if url:
            absolute_url = urljoin(base_url, url)
            assets[absolute_url] = {'type': 'Image'}
            
    # Add the base HTML document itself as an asset
    assets[base_url] = {'type': 'HTML Document'}

    # Convert the dictionary to a list and add domain info
    asset_list = []
    for url, data in assets.items():
        domain = urlparse(url).netloc
        if domain:
            asset_list.append({
                'url': url,
                'domain': domain,
                'type': data['type']
            })
    return asset_list

# The get_ip_from_domain and get_geolocation functions remain the same.
def get_ip_from_domain(domain):
    try:
        answers = dns.resolver.resolve(domain, 'A')
        return str(answers[0])
    except Exception:
        return None

def get_geolocation(ip_address):
    try:
        response = requests.get(f'http://ip-api.com/json/{ip_address}?fields=status,lat,lon,city,country')
        response.raise_for_status()
        data = response.json()
        if data and data.get('status') == 'success':
            return {"city": data.get('city', 'Unknown'), "country": data.get('country', 'Unknown')}
    except Exception:
        return None

# --- Main Execution Block ---

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python local_analyzer_v2.py <your_url>")
        sys.exit()

    target_url = sys.argv[1]
    print(f"--- Starting dynamic analysis for: {target_url} ---")

    try:
        print("Step 1: Fetching fully rendered HTML with Selenium...")
        final_html = get_dynamic_html_with_selenium(target_url)
        soup = BeautifulSoup(final_html, 'html.parser')
        
        print("\nStep 2: Discovering all unique assets from dynamic HTML...")
        unique_assets = get_unique_assets(target_url, soup)
        print(f"...Found {len(unique_assets)} unique assets.")

        print("\nStep 3: Analyzing each asset's domain to find its server location...")
        
        # We'll group assets by their domain to avoid repeating lookups
        domains_to_analyze = {asset['domain'] for asset in unique_assets}
        domain_locations = {}
        
        for domain in domains_to_analyze:
            ip = get_ip_from_domain(domain)
            if ip:
                location = get_geolocation(ip)
                if location:
                    domain_locations[domain] = {'ip': ip, 'location': f"{location['city']}, {location['country']}"}
                    print(f"  [+] Analyzed Domain: {domain} -> {ip} ({domain_locations[domain]['location']})")
        
        print("\nStep 4: Compiling and saving detailed results to analysis_results_v2.txt...")
        with open("analysis_results_v2.txt", "w") as f:
            f.write(f"----- Dynamic Analysis for {target_url} at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} -----\n\n")
            for domain, data in domain_locations.items():
                f.write(f"Server Location: {data['location']} (IP: {data['ip']})\n")
                f.write(f"  Domain: {domain}\n")
                f.write("  Assets Fetched From This Domain:\n")
                for asset in unique_assets:
                    if asset['domain'] == domain:
                        # Truncate long asset URLs for cleaner output
                        display_url = asset['url'] if len(asset['url']) < 80 else asset['url'][:77] + "..."
                        f.write(f"    - [{asset['type']:<12}] {display_url}\n")
                f.write("\n")

        print("...Done! Check analysis_results_v2.txt for the full report.")

    except Exception as e:
        print(f"\nAn unexpected error occurred: {e}")
