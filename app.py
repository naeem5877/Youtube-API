from flask import Flask, request, jsonify, send_file
import yt_dlp
import os
import uuid
import threading
import time
import json
import requests
from werkzeug.utils import secure_filename
from flask_cors import CORS
import ssl
import urllib3
import signal
import sys
from contextlib import contextmanager
import subprocess

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": ["http://localhost:3000", "https://vibedownloader.vercel.app", "https://vibedownloader.me", "https://www.vibedownloader.me", "https://ytapi.vibedownloader.me/"]}})

# Disable SSL warnings for proxy usage
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Configuration
DOWNLOAD_FOLDER = os.path.join(os.getcwd(), "downloads")
TEMP_FOLDER = os.path.join(os.getcwd(), "temp")

# ScraperAPI proxy configuration
SCRAPERAPI_PROXY = {
    "https": "scraperapi:d32b11d359813d5ed5c519bfbdec6f23@proxy-server.scraperapi.com:8001",
    "http": "scraperapi:d32b11d359813d5ed5c519bfbdec6f23@proxy-server.scraperapi.com:8001"
}

# Create necessary directories
os.makedirs(DOWNLOAD_FOLDER, exist_ok=True)
os.makedirs(TEMP_FOLDER, exist_ok=True)

# Dictionary to store download progress info
downloads_in_progress = {}
completed_downloads = {}

# Timeout handler
@contextmanager
def timeout_context(seconds):
    def timeout_handler(signum, frame):
        raise TimeoutError(f"Operation timed out after {seconds} seconds")
    
    # Set the signal handler and a alarm for the specified seconds
    old_handler = signal.signal(signal.SIGALRM, timeout_handler)
    signal.alarm(seconds)
    
    try:
        yield
    finally:
        # Restore the old handler and cancel the alarm
        signal.signal(signal.SIGALRM, old_handler)
        signal.alarm(0)

# Function to clean up old files periodically
def cleanup_old_files():
    while True:
        try:
            now = time.time()
            # Delete files older than 2 hours
            for folder in [DOWNLOAD_FOLDER, TEMP_FOLDER]:
                if os.path.exists(folder):
                    for filename in os.listdir(folder):
                        file_path = os.path.join(folder, filename)
                        if os.path.isfile(file_path) and now - os.path.getmtime(file_path) > 7200:  # 2 hours
                            try:
                                os.remove(file_path)
                            except Exception as e:
                                print(f"Error deleting {file_path}: {e}")

            # Clean up completed downloads dictionary
            to_remove = []
            for download_id, info in completed_downloads.items():
                if now - info.get("completion_time", 0) > 7200:  # 2 hours
                    to_remove.append(download_id)

            for download_id in to_remove:
                completed_downloads.pop(download_id, None)

        except Exception as e:
            print(f"Cleanup error: {e}")
        
        time.sleep(3600)  # Check every hour

# Start cleanup thread
cleanup_thread = threading.Thread(target=cleanup_old_files, daemon=True)
cleanup_thread.start()

def get_base_ydl_opts():
    """Return base yt-dlp options with proxy configuration and SSL fixes"""
    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'ignoreerrors': True,
        'proxy': 'scraperapi:d32b11d359813d5ed5c519bfbdec6f23@proxy-server.scraperapi.com:8001',
        'socket_timeout': 20,  # Reduced timeout
        'retries': 2,          # Reduced retries
        # SSL and certificate fixes
        'nocheckcertificate': True,
        'geo_bypass': True,
        'prefer_insecure': True,
        # Memory and performance optimizations
        'extract_flat': False,
        'writesubtitles': False,
        'writeautomaticsub': False,
        'age_limit': None,
        'no_color': True,
        'force_json': False,
        # Reduced headers to minimize memory usage
        'http_headers': {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'keep-alive',
        },
    }
    return ydl_opts

def get_lightweight_ydl_opts():
    """Return lightweight yt-dlp options for info extraction only"""
    return {
        'quiet': True,
        'no_warnings': True,
        'ignoreerrors': True,
        'proxy': 'scraperapi:d32b11d359813d5ed5c519bfbdec6f23@proxy-server.scraperapi.com:8001',
        'socket_timeout': 15,
        'retries': 1,
        'nocheckcertificate': True,
        'geo_bypass': True,
        'prefer_insecure': True,
        'extract_flat': True,  # Faster extraction
        'no_color': True,
        'http_headers': {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
    }

def test_proxy_connection():
    """Test if the proxy is working with timeout"""
    try:
        with timeout_context(10):
            response = requests.get('https://youtube.com', 
                                  proxies=SCRAPERAPI_PROXY, 
                                  verify=False, 
                                  timeout=8,
                                  headers={'User-Agent': 'Mozilla/5.0'})
            return response.status_code == 200
    except Exception as e:
        print(f"Proxy test failed: {e}")
        return False

def extract_video_info_safe(url):
    """Safely extract video info with timeout and error handling"""
    try:
        with timeout_context(30):  # 30 second timeout
            ydl_opts = get_lightweight_ydl_opts()
            
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                # First try to get basic info
                info = ydl.extract_info(url, download=False)
                
                if not info:
                    raise Exception("Could not extract video information")
                
                return info
                
    except TimeoutError:
        raise Exception("Request timed out - video may be unavailable or proxy is slow")
    except Exception as e:
        print(f"Error extracting info: {e}")
        raise Exception(f"Failed to extract video info: {str(e)}")

def get_verification_status(channel_data):
    """Check if channel is verified based on badges in channel data"""
    try:
        badges = channel_data.get('badges', [])
        for badge in badges:
            if badge and isinstance(badge, dict) and 'verified' in badge.get('type', '').lower():
                return True
        return False
    except:
        return False

@app.route('/api/video-info', methods=['GET'])
def get_video_info():
    """
    Get video information including available formats with timeout protection
    """
    url = request.args.get('url')
    if not url:
        return jsonify({"error": "Missing video URL"}), 400

    try:
        # Extract video info with timeout protection
        info = extract_video_info_safe(url)
        video_id = info.get('id')

        if not video_id:
            return jsonify({"error": "Could not extract video ID"}), 400

        # Extract relevant information safely
        result = {
            "id": video_id,
            "title": info.get('title', 'Unknown Title'),
            "description": info.get('description', '')[:500] if info.get('description') else '',  # Limit description
            "duration": info.get('duration'),
            "view_count": info.get('view_count'),
            "like_count": info.get('like_count'),
            "upload_date": info.get('upload_date'),
            "thumbnails": info.get('thumbnails', [])[:5],  # Limit thumbnails
            "channel": {
                "id": info.get('channel_id'),
                "name": info.get('channel', info.get('uploader', 'Unknown Channel')),
                "url": info.get('channel_url'),
                "profile_picture": None,
                "verified": get_verification_status(info)
            },
            "audio_formats": [],
            "video_formats": []
        }

        # Extract formats safely
        formats = info.get('formats', [])
        
        # Audio formats
        audio_formats = []
        for format in formats:
            try:
                if format.get('vcodec') == 'none' and format.get('acodec') != 'none':
                    audio_formats.append({
                        "format_id": format.get('format_id'),
                        "ext": format.get('ext', 'unknown'),
                        "filesize": format.get('filesize'),
                        "format_note": format.get('format_note', ''),
                        "abr": format.get('abr'),
                        "download_url": f"/api/direct-download/{video_id}/{format.get('format_id')}"
                    })
                    if len(audio_formats) >= 10:  # Limit number of formats
                        break
            except Exception:
                continue

        result["audio_formats"] = audio_formats

        # Video formats
        video_formats = []
        for format in formats:
            try:
                if format.get('vcodec') != 'none':
                    video_formats.append({
                        "format_id": format.get('format_id'),
                        "ext": format.get('ext', 'unknown'),
                        "filesize": format.get('filesize'),
                        "format_note": format.get('format_note', ''),
                        "width": format.get('width'),
                        "height": format.get('height'),
                        "fps": format.get('fps'),
                        "vcodec": format.get('vcodec', ''),
                        "acodec": format.get('acodec', ''),
                        "download_url": f"/api/direct-download/{video_id}/{format.get('format_id')}",
                        "resolution": f"{format.get('width', 0)}x{format.get('height', 0)}"
                    })
                    if len(video_formats) >= 15:  # Limit number of formats
                        break
            except Exception:
                continue

        result["video_formats"] = video_formats

        return jsonify(result)

    except Exception as e:
        error_msg = str(e)
        print(f"Error in get_video_info: {error_msg}")
        
        # Return user-friendly error messages
        if "timed out" in error_msg.lower():
            return jsonify({"error": "Request timed out. Please try again."}), 504
        elif "unavailable" in error_msg.lower():
            return jsonify({"error": "Video is unavailable or private."}), 404
        else:
            return jsonify({"error": f"Failed to get video info: {error_msg}"}), 500

@app.route('/api/download', methods=['GET'])
def download_video():
    """Download a video with better error handling"""
    url = request.args.get('url')
    format_id = request.args.get('format_id')
    audio_id = request.args.get('audio_id')

    if not url:
        return jsonify({"error": "Missing video URL"}), 400

    download_id = str(uuid.uuid4())

    # Start download in background
    thread = threading.Thread(
        target=process_download,
        args=(download_id, url, format_id, audio_id)
    )
    thread.daemon = True
    thread.start()

    return jsonify({
        "download_id": download_id,
        "status": "processing",
        "message": "Download started. Check status using the /api/download-status endpoint."
    })

def process_download(download_id, url, format_id=None, audio_id=None):
    """Process video download with timeout protection"""
    downloads_in_progress[download_id] = {
        "status": "downloading",
        "progress": 0,
        "url": url,
        "start_time": time.time()
    }

    try:
        with timeout_context(300):  # 5 minute timeout for downloads
            output_filename = f"{download_id}.mp4"
            output_path = os.path.join(DOWNLOAD_FOLDER, output_filename)

            ydl_opts = get_base_ydl_opts()
            ydl_opts.update({
                'outtmpl': os.path.join(TEMP_FOLDER, f"{download_id}_%(title)s.%(ext)s"),
                'progress_hooks': [lambda d: update_progress(download_id, d)],
            })

            # Format selection
            if format_id:
                if audio_id:
                    format_selector = f"{format_id}+{audio_id}"
                else:
                    format_selector = f"{format_id}+bestaudio/best"
            else:
                format_selector = 'bestvideo+bestaudio/best'

            ydl_opts.update({
                'format': format_selector,
                'merge_output_format': 'mp4',
            })

            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url)
                downloaded_file = ydl.prepare_filename(info)

                # Find and move the actual downloaded file
                actual_file = find_downloaded_file(downloaded_file)
                if actual_file and os.path.exists(actual_file):
                    os.rename(actual_file, output_path)

            completed_downloads[download_id] = {
                "status": "completed",
                "url": url,
                "file_path": output_path,
                "download_url": f"/api/get-file/{download_id}",
                "completion_time": time.time()
            }

    except TimeoutError:
        completed_downloads[download_id] = {
            "status": "failed",
            "url": url,
            "error": "Download timed out",
            "completion_time": time.time()
        }
    except Exception as e:
        completed_downloads[download_id] = {
            "status": "failed",
            "url": url,
            "error": str(e),
            "completion_time": time.time()
        }
    finally:
        if download_id in downloads_in_progress:
            downloads_in_progress.pop(download_id)

def find_downloaded_file(base_filename):
    """Find the actual downloaded file with various possible extensions"""
    if not base_filename:
        return None
        
    if os.path.exists(base_filename):
        return base_filename
    
    # Try different extensions
    base_no_ext = base_filename.rsplit(".", 1)[0] if "." in base_filename else base_filename
    for ext in ['mp4', 'webm', 'mkv', 'm4a', 'mp3', 'f4v']:
        candidate = f"{base_no_ext}.{ext}"
        if os.path.exists(candidate):
            return candidate
    
    return None

def update_progress(download_id, d):
    """Update download progress information safely"""
    try:
        if download_id in downloads_in_progress:
            if d['status'] == 'downloading':
                percent_str = d.get('_percent_str', '0%')
                if percent_str and percent_str != 'N/A' and '%' in percent_str:
                    try:
                        downloads_in_progress[download_id]['progress'] = float(percent_str.replace('%', ''))
                    except (ValueError, TypeError):
                        pass
            elif d['status'] == 'finished':
                downloads_in_progress[download_id]['status'] = 'processing'
                downloads_in_progress[download_id]['progress'] = 100
    except Exception:
        pass

@app.route('/api/download-status/<download_id>', methods=['GET'])
def check_download_status(download_id):
    """Check download status"""
    if download_id in downloads_in_progress:
        return jsonify({
            "download_id": download_id,
            "status": downloads_in_progress[download_id]["status"],
            "progress": downloads_in_progress[download_id]["progress"],
            "url": downloads_in_progress[download_id]["url"]
        })

    if download_id in completed_downloads:
        response_data = {
            "download_id": download_id,
            "status": completed_downloads[download_id]["status"],
            "url": completed_downloads[download_id]["url"]
        }
        
        if "download_url" in completed_downloads[download_id]:
            response_data["download_url"] = completed_downloads[download_id]["download_url"]
        
        if "error" in completed_downloads[download_id]:
            response_data["error"] = completed_downloads[download_id]["error"]
            
        return jsonify(response_data)

    return jsonify({"error": "Download ID not found"}), 404

@app.route('/api/get-file/<download_id>', methods=['GET'])
def get_downloaded_file(download_id):
    """Get downloaded file"""
    if download_id in completed_downloads and completed_downloads[download_id]["status"] == "completed":
        file_path = completed_downloads[download_id]["file_path"]

        if os.path.exists(file_path):
            filename = os.path.basename(file_path)
            return send_file(file_path, as_attachment=True, download_name=filename)

    return jsonify({"error": "File not found"}), 404

@app.route('/api/direct-download/<video_id>/<format_id>', methods=['GET'])
def direct_download(video_id, format_id):
    """Direct download with timeout protection"""
    try:
        with timeout_context(180):  # 3 minute timeout
            audio_id = request.args.get('audio_id')
            custom_filename = request.args.get('filename')
            url = f"https://www.youtube.com/watch?v={video_id}"

            # Create filename
            filename = f"{video_id}_{format_id}"
            if audio_id:
                filename += f"_{audio_id}"
            filename += ".mp4"

            output_path = os.path.join(DOWNLOAD_FOLDER, filename)

            # Check cache
            if os.path.exists(output_path):
                download_name = custom_filename if custom_filename else f"{video_id}.mp4"
                return send_file(output_path, as_attachment=True, download_name=download_name)

            # Download
            ydl_opts = get_base_ydl_opts()
            ydl_opts.update({
                'outtmpl': output_path,
                'format': f"{format_id}+bestaudio" if not audio_id else f"{format_id}+{audio_id}",
                'merge_output_format': 'mp4',
            })

            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url)
                
                if not custom_filename and info.get('title'):
                    video_title = ''.join(c for c in info.get('title') if c.isalnum() or c in ' ._-')
                    download_name = f"{video_title}.mp4"
                else:
                    download_name = custom_filename if custom_filename else f"{video_id}.mp4"

            # Find and serve file
            actual_file = find_downloaded_file(output_path)
            if actual_file and os.path.exists(actual_file):
                if actual_file != output_path:
                    os.rename(actual_file, output_path)
                return send_file(output_path, as_attachment=True, download_name=download_name)
            else:
                return jsonify({"error": "Download failed"}), 500

    except TimeoutError:
        return jsonify({"error": "Download timed out"}), 504
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/proxy-test', methods=['GET'])
def test_proxy():
    """Test proxy with timeout"""
    try:
        with timeout_context(10):
            response = requests.get('https://youtube.com', 
                                  proxies=SCRAPERAPI_PROXY, 
                                  verify=False, 
                                  timeout=8,
                                  headers={'User-Agent': 'Mozilla/5.0'})
            return jsonify({
                "status": "success",
                "proxy_working": True,
                "status_code": response.status_code,
                "message": "Proxy connection successful"
            })
    except Exception as e:
        return jsonify({
            "status": "error",
            "proxy_working": False,
            "error": str(e),
            "message": "Proxy connection failed"
        }), 500

@app.route('/api/health', methods=['GET'])
def health_check():
    """Health check with timeout"""
    try:
        proxy_status = test_proxy_connection()
        return jsonify({
            "status": "ok",
            "version": "1.0.2",
            "proxy_working": proxy_status,
            "proxy_config": "ScraperAPI with timeout protection"
        })
    except:
        return jsonify({
            "status": "ok",
            "version": "1.0.2",
            "proxy_working": False,
            "proxy_config": "ScraperAPI with timeout protection"
        })

if __name__ == '__main__':
    print("Starting YouTube Downloader with timeout protection...")
    try:
        print("Testing ScraperAPI proxy connection...")
        if test_proxy_connection():
            print("✓ Proxy connection successful")
        else:
            print("✗ Proxy connection failed - downloads may not work properly")
    except:
        print("✗ Could not test proxy connection")
    
    app.run(host='0.0.0.0', port=8080)
