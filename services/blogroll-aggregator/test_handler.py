import os
import sys
import json
import io
from unittest.mock import MagicMock

# Add current folder to sys.path so we can import handler
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

# Mock boto3 before importing handler
import boto3

mock_s3 = MagicMock()
boto3.client = MagicMock(return_value=mock_s3)

# Mock S3 NoSuchKey exception structure
class MockS3Error(Exception):
    def __init__(self, code):
        self.response = {"Error": {"Code": code}}
        super().__init__(f"Mock S3 Error: {code}")

local_output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "test_output.json")
local_cache_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "test_cache_state.json")

# Mock S3 get_object
def get_object_mock(Bucket, Key):
    print(f"\n[Mock S3] Reading from s3://{Bucket}/{Key}")
    if Key == 'cache_state.json':
        if os.path.exists(local_cache_path):
            print(f"[Mock S3] Cache file found. Loading: {local_cache_path}")
            with open(local_cache_path, "rb") as f:
                content = f.read()
            return {"Body": io.BytesIO(content)}
        else:
            print("[Mock S3] Cache file not found.")
            raise MockS3Error("NoSuchKey")
    raise MockS3Error("NoSuchKey")

mock_s3.get_object.side_effect = get_object_mock

# Mock S3 put_object
def put_object_mock(Bucket, Key, Body, ContentType=None, ACL=None):
    print(f"\n[Mock S3] Uploading to s3://{Bucket}/{Key}")
    print(f"[Mock S3] Content Type: {ContentType}")
    print(f"[Mock S3] ACL: {ACL}")
    
    if Key == 'cache_state.json':
        with open(local_cache_path, "wb") as f:
            f.write(Body)
        print(f"[Mock S3] Saved cache state locally to: {local_cache_path}")
    else:
        with open(local_output_path, "wb") as f:
            f.write(Body)
        print(f"[Mock S3] Saved output copy locally to: {local_output_path}")
    return {"ResponseMetadata": {"HTTPStatusCode": 200}}

mock_s3.put_object.side_effect = put_object_mock

import handler

def run_test():
    # Setup test environment variables
    os.environ['OPML_URL'] = 'https://www.inoreader.com/reader/subscriptions/export/user/1006091082/label/Blaugust%202026'
    os.environ['OUTPUT_BUCKET_NAME'] = 'test-blogroll-bucket'
    os.environ['OUTPUT_FILE_KEY'] = 'blogroll.json'
    
    # Clean up previous cache file if it exists, to ensure a clean start
    if os.path.exists(local_cache_path):
        os.remove(local_cache_path)
        print("Cleaned up previous test_cache_state.json for test consistency.")

    print("\n==================================================")
    print("--- RUN 1: Cache Miss (Fresh run, full downloads) ---")
    print("==================================================")
    response1 = handler.handler({}, None)
    
    print("\n==================================================")
    print("--- RUN 2: Cache Hit (Expect skips for unchanged feeds) ---")
    print("==================================================")
    response2 = handler.handler({}, None)
    
    print("\n==================================================")
    print("--- Verification Results ---")
    print("==================================================")
    
    print("\nHandler Response (Run 1):")
    print(json.dumps(response1, indent=2))
    
    print("\nHandler Response (Run 2):")
    print(json.dumps(response2, indent=2))
    
    if response2["statusCode"] == 200:
        print("\nVerification successful! Reading local output file:")
        with open(local_output_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            
            # Print basic stats
            print(f"- Version: {data.get('version')}")
            print(f"- Title: {data.get('title')}")
            print(f"- Total Items Aggregated: {len(data.get('items', []))}")
            
            # Check sorting and fields of first few items
            items = data.get('items', [])
            if items:
                print("\nFirst 3 items:")
                for i, item in enumerate(items[:3]):
                    print(f"  {i+1}. Blog: {item.get('_site_title')} | Title: {item.get('title')}")
                    print(f"     URL: {item.get('url')}")
                    print(f"     Author: {item.get('authors', [{}])[0].get('name')}")
                    print(f"     Date: {item.get('date_published')}")
                
                # Check sorting order
                dates = [item.get('date_published') for item in items if item.get('date_published')]
                is_sorted = all(dates[i] >= dates[i+1] for i in range(len(dates)-1))
                print(f"\nSorting verification: {'PASSED (reverse chronological)' if is_sorted else 'FAILED (not sorted correctly)'}")
            else:
                print("Warning: No items parsed.")
    else:
        print("\nVerification FAILED. See logger output above.")

if __name__ == "__main__":
    run_test()
