import os
import json
import logging
import urllib.request
import urllib.error
import ssl
import email.utils
from datetime import datetime, timezone
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
import boto3

# Configure Logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Helper to find elements regardless of namespaces
def find_element(parent, local_name):
    for elem in parent:
        tag_without_ns = elem.tag.split('}')[-1]
        if tag_without_ns == local_name:
            return elem
    return None

def find_elements_recursive(parent, local_name):
    results = []
    for elem in parent.iter():
        tag_without_ns = elem.tag.split('}')[-1]
        if tag_without_ns == local_name:
            results.append(elem)
    return results

# Robust Date Parser
def parse_date(date_str):
    if not date_str:
        return None
    date_str = date_str.strip()

    # 1. Try ISO 8601 format (Atom / JSON Feed)
    try:
        normalized = date_str
        if normalized.endswith('Z'):
            normalized = normalized[:-1] + '+00:00'
        dt = datetime.fromisoformat(normalized)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError:
        pass

    # 2. Try RFC 822 / 2822 format (RSS)
    try:
        dt = email.utils.parsedate_to_datetime(date_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        pass

    # 3. Fallback standard formats
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%d %b %Y %H:%M:%S"):
        try:
            dt = datetime.strptime(date_str, fmt)
            return dt.replace(tzinfo=timezone.utc)
        except ValueError:
            pass

    return None

# Helper to fetch URL content with User-Agent supporting GET and HEAD requests
def fetch_url(url, user_agent, method='GET'):
    req = urllib.request.Request(
        url,
        headers={'User-Agent': user_agent},
        method=method
    )
    # Permissive SSL context (essential for small/hobby blogs with mismatched or expired certs)
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE

    with urllib.request.urlopen(req, timeout=10, context=context) as response:
        if method == 'HEAD':
            return response.info()
        return response.read()

# Helper to check if feed has changed using HTTP HEAD request
def check_feed_changed(url, user_agent, cached_etag, cached_last_modified):
    try:
        headers = fetch_url(url, user_agent, method='HEAD')
        etag = headers.get('ETag')
        last_modified = headers.get('Last-Modified')

        # If the server returned neither header, we cannot cache it based on headers
        if not etag and not last_modified:
            return True, None, None

        # Compare headers case-insensitively using helper
        def headers_match(new_val, cached_val):
            if new_val is None and cached_val is None:
                return True
            if new_val is not None and cached_val is not None:
                return new_val.strip() == cached_val.strip()
            return False

        if headers_match(etag, cached_etag) and headers_match(last_modified, cached_last_modified):
            return False, etag, last_modified

        return True, etag, last_modified
    except Exception as e:
        logger.warning(f"HEAD request failed for {url}: {e}. Falling back to full GET.")
        return True, None, None

# Helper to construct a standard formatted post item
def format_post(url, title, parsed_dt, author_name, blog_name):
    return {
        "id": url,
        "url": url,
        "title": title or "Untitled",
        "date_published": parsed_dt.isoformat() if parsed_dt else None,
        "authors": [{"name": author_name}] if author_name else [{"name": blog_name}],
        "_site_title": blog_name,
        "_parsed_date": parsed_dt if parsed_dt else datetime.min.replace(tzinfo=timezone.utc)
    }

# Helper to parse a JSON Feed
def parse_json_feed(content, blog_name):
    data = json.loads(content.decode('utf-8', errors='ignore'))
    items = data.get('items', [])
    parsed_posts = []
    for item in items[:1]:
        title = item.get('title')
        url = item.get('url')
        
        # Date
        date_raw = item.get('date_published') or item.get('date_modified')
        parsed_dt = parse_date(date_raw)
        
        # Author
        author_name = None
        authors = item.get('authors', [])
        if authors and isinstance(authors, list):
            author_name = authors[0].get('name')
        else:
            author = item.get('author')
            if isinstance(author, dict):
                author_name = author.get('name')
            elif isinstance(author, str):
                author_name = author

        if url:
            parsed_posts.append(format_post(url, title, parsed_dt, author_name, blog_name))
    return parsed_posts

# Helper to parse an XML (RSS/Atom) Feed
def parse_xml_feed(content, blog_name):
    root = ET.fromstring(content)
    
    # Try to find entries (Atom: <entry>, RSS: <item>)
    items = find_elements_recursive(root, 'item')
    is_rss = True
    if not items:
        items = find_elements_recursive(root, 'entry')
        is_rss = False

    if not items:
        logger.warning(f"No feed items or entries found in XML content.")
        return []

    parsed_posts = []
    for item in items[:1]:
        title_elem = find_element(item, 'title')
        title = title_elem.text.strip() if title_elem is not None and title_elem.text else "Untitled"

        # Link Extraction
        url = None
        link_elem = find_element(item, 'link')
        if link_elem is not None:
            url = link_elem.attrib.get('href') or link_elem.text
        if url:
            url = url.strip()

        # Date Extraction
        date_raw = None
        if is_rss:
            date_elem = find_element(item, 'pubDate') or find_element(item, 'date')
        else:
            date_elem = find_element(item, 'updated') or find_element(item, 'published')
        
        if date_elem is not None and date_elem.text:
            date_raw = date_elem.text.strip()
        
        parsed_dt = parse_date(date_raw)

        # Author Extraction
        author_name = None
        creator_elem = find_element(item, 'creator') # e.g. dc:creator
        if creator_elem is not None and creator_elem.text:
            author_name = creator_elem.text.strip()
        else:
            author_elem = find_element(item, 'author')
            if author_elem is not None:
                name_elem = find_element(author_elem, 'name')
                if name_elem is not None and name_elem.text:
                    author_name = name_elem.text.strip()
                elif author_elem.text:
                    author_name = author_elem.text.strip()
                    # Clean up RSS format: email@example.com (Author Name)
                    if '(' in author_name and author_name.endswith(')'):
                        author_name = author_name.split('(')[-1][:-1].strip()

        if url:
            parsed_posts.append(format_post(url, title, parsed_dt, author_name, blog_name))
    return parsed_posts

# Core worker logic to fetch and parse a single feed
def fetch_and_parse_feed(feed_url, blog_name, user_agent, cached_entry):
    cached_etag = cached_entry.get('etag') if cached_entry else None
    cached_last_modified = cached_entry.get('last_modified') if cached_entry else None
    cached_posts = cached_entry.get('posts') if cached_entry else None

    # 1. If cached posts exist, check if feed changed with a HEAD request
    has_changed = True
    new_etag = None
    new_last_modified = None

    if cached_posts:
        has_changed, new_etag, new_last_modified = check_feed_changed(
            feed_url, user_agent, cached_etag, cached_last_modified
        )
        if not has_changed:
            logger.info(f"Cache hit for feed: {feed_url} ({blog_name}). Skipping download.")
            # Restore parsed dates for correct sorting
            restored_posts = []
            for post in cached_posts:
                restored = post.copy()
                restored['_parsed_date'] = parse_date(post.get('date_published')) or datetime.min.replace(tzinfo=timezone.utc)
                restored_posts.append(restored)
            return restored_posts, cached_etag, cached_last_modified

    # 2. Cache miss or feed changed - perform full GET download
    try:
        logger.info(f"Fetching feed via GET: {feed_url} ({blog_name})")
        req = urllib.request.Request(feed_url, headers={'User-Agent': user_agent})
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE

        with urllib.request.urlopen(req, timeout=10, context=context) as response:
            content = response.read()
            # Capture headers from response
            headers = response.info()
            final_etag = headers.get('ETag') or new_etag
            final_last_modified = headers.get('Last-Modified') or new_last_modified
    except Exception as e:
        logger.warning(f"Failed to download feed {feed_url}: {e}")
        return None

    # 3. Parse feed content based on format
    try:
        trimmed = content.strip()
        if trimmed.startswith(b'{'):
            parsed_posts = parse_json_feed(content, blog_name)
        else:
            parsed_posts = parse_xml_feed(content, blog_name)
        return parsed_posts, final_etag, final_last_modified
    except Exception as e:
        logger.warning(f"Failed parsing feed {feed_url}: {e}")

    return None

# Helper to download S3 cache state
def load_cache_state(s3, bucket_name, cache_file_key):
    try:
        response = s3.get_object(Bucket=bucket_name, Key=cache_file_key)
        cache_state = json.loads(response['Body'].read().decode('utf-8'))
        logger.info(f"Loaded cache state for {len(cache_state.get('feeds', {}))} feeds.")
        return cache_state
    except Exception as e:
        # Check for NoSuchKey
        if hasattr(e, 'response') and e.response.get('Error', {}).get('Code') == 'NoSuchKey':
            logger.info("No cache state file found. Starting fresh.")
        else:
            logger.warning(f"Failed to load cache state: {e}. Starting fresh.")
    return {"feeds": {}}

# Helper to fetch and parse OPML subscription lists
def parse_opml_feeds(opml_url, user_agent):
    try:
        opml_content = fetch_url(opml_url, user_agent)
        opml_root = ET.fromstring(opml_content)
    except Exception as e:
        logger.error(f"Failed to fetch or parse OPML from {opml_url}: {e}")
        return None

    feeds = []
    outlines = find_elements_recursive(opml_root, 'outline')
    for outline in outlines:
        xml_url = outline.attrib.get('xmlUrl')
        if xml_url:
            blog_name = outline.attrib.get('title') or outline.attrib.get('text') or "Unknown Blog"
            feeds.append((xml_url.strip(), blog_name.strip()))
    return feeds

# Helper to write aggregated JSON Feed back to S3
def save_aggregated_feed(s3, bucket_name, file_key, opml_url, clean_items):
    feed_data = {
        "version": "https://jsonfeed.org/version/1.1",
        "title": "Blogroll Aggregator Feed",
        "home_page_url": opml_url,
        "items": clean_items
    }
    try:
        json_content = json.dumps(feed_data, indent=2, ensure_ascii=False)
        s3.put_object(
            Bucket=bucket_name,
            Key=file_key,
            Body=json_content.encode('utf-8'),
            ContentType='application/feed+json; charset=utf-8'
        )
        logger.info(f"Successfully aggregated {len(clean_items)} items and uploaded public feed to s3://{bucket_name}/{file_key}")
        return True
    except Exception as e:
        logger.error(f"Failed to upload json feed to S3: {e}")
        return False

# Helper to write updated cache state back to S3
def save_cache_state(s3, bucket_name, cache_file_key, new_cache_feeds):
    try:
        cache_content = json.dumps({"feeds": new_cache_feeds}, indent=2, ensure_ascii=False)
        s3.put_object(
            Bucket=bucket_name,
            Key=cache_file_key,
            Body=cache_content.encode('utf-8'),
            ContentType='application/json'
        )
        logger.info(f"Successfully updated cache state file s3://{bucket_name}/{cache_file_key}")
    except Exception as e:
        logger.warning(f"Failed to upload cache state to S3: {e}")

# Lambda Entry Point Orchestrator
def handler(event, context):
    opml_url = os.environ.get('OPML_URL')
    bucket_name = os.environ.get('OUTPUT_BUCKET_NAME')
    file_key = os.environ.get('OUTPUT_FILE_KEY', 'blogroll.json')
    cache_file_key = 'cache_state.json'
    user_agent = os.environ.get('USER_AGENT', 'BathtubRobot/1.0 (OPML Blogroll Aggregator; +https://github.com/tkrehbiel/bathtub-robot-services)')

    if not opml_url:
        raise ValueError("OPML_URL environment variable is required")
    if not bucket_name:
        raise ValueError("OUTPUT_BUCKET_NAME environment variable is required")

    logger.info(f"Starting aggregation. OPML URL: {opml_url}, Target S3: s3://{bucket_name}/{file_key}")

    endpoint_url = os.environ.get('AWS_ENDPOINT_URL')
    if not endpoint_url and os.environ.get('LOCALSTACK_HOSTNAME'):
        endpoint_url = f"http://{os.environ['LOCALSTACK_HOSTNAME']}:4566"
    s3 = boto3.client('s3', endpoint_url=endpoint_url)

    # 1. Download previous cache state from S3
    cache_state = load_cache_state(s3, bucket_name, cache_file_key)

    # 2. Fetch and parse OPML to get feed list
    feeds = parse_opml_feeds(opml_url, user_agent)
    if feeds is None:
        return {"statusCode": 500, "body": "Failed to fetch or parse OPML"}

    logger.info(f"Parsed {len(feeds)} blog feeds from OPML.")

    # 3. Concurrently fetch all blog feeds, passing cached entries
    aggregated_items = []
    new_cache_feeds = {}
    cached_feeds_map = cache_state.get('feeds', {})

    with ThreadPoolExecutor(max_workers=15) as executor:
        future_to_feed = {
            executor.submit(
                fetch_and_parse_feed,
                url,
                name,
                user_agent,
                cached_feeds_map.get(url)
            ): (url, name)
            for url, name in feeds
        }
        for future in as_completed(future_to_feed):
            url, name = future_to_feed[future]
            try:
                result = future.result()
            except Exception as exc:
                logger.warning(f"Feed {url} generated an exception: {exc}")
                result = None

            if result:
                posts, etag, last_modified = result
                aggregated_items.extend(posts)
                # Update cache
                new_cache_feeds[url] = {
                    "etag": etag,
                    "last_modified": last_modified,
                    "posts": [
                        {k: v for k, v in post.items() if k != '_parsed_date'}
                        for post in posts
                    ]
                }
            else:
                # Fallback: keep previous cache privately if failed/exception occurred
                prev_cache = cached_feeds_map.get(url)
                if prev_cache:
                    new_cache_feeds[url] = prev_cache

    # 4. Sort items in reverse chronological order
    aggregated_items.sort(key=lambda x: x['_parsed_date'], reverse=True)

    # 5. Clean up items by removing internal helper keys (preserving standard custom keys like _site_title)
    clean_items = []
    for item in aggregated_items:
        clean_item = {k: v for k, v in item.items() if k != '_parsed_date'}
        clean_items.append(clean_item)

    # 6. Upload JSON Feed to S3
    if not save_aggregated_feed(s3, bucket_name, file_key, opml_url, clean_items):
        return {"statusCode": 500, "body": "Failed S3 upload of public feed"}

    # 7. Upload updated cache state to S3 (private state file)
    save_cache_state(s3, bucket_name, cache_file_key, new_cache_feeds)

    return {
        "statusCode": 200,
        "body": json.dumps({
            "message": "Aggregation completed successfully",
            "total_items": len(clean_items),
            "s3_path": f"s3://{bucket_name}/{file_key}",
            "cache_state_path": f"s3://{bucket_name}/{cache_file_key}"
        })
    }
