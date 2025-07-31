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

# Function to clean up old files periodically
def cleanup_old_files():
    while True:
        now = time.time()
        # Delete files older than 2 hours
        for folder in [DOWNLOAD_FOLDER, TEMP_FOLDER]:
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
        'socket_timeout': 30,
        'retries': 3,
        # SSL and certificate fixes
        'nocheckcertificate': True,  # Disable SSL certificate verification
        'geo_bypass': True,
        'prefer_insecure': True,     # Use HTTP instead of HTTPS when possible
        # Additional headers to help with bot detection
        'http_headers': {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Cache-Control': 'max-age=0',
        },
        # Additional options to handle various issues
        'extract_flat': False,
        'writesubtitles': False,
        'writeautomaticsub': False,
        'age_limit': None,
    }
    return ydl_opts

def test_proxy_connection():
    """Test if the proxy is working"""
    try:
        response = requests.get('https://youtube.com', 
                              proxies=SCRAPERAPI_PROXY, 
                              verify=False, 
                              timeout=10,
                              headers={
                                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                              })
        return response.status_code == 200
    except Exception as e:
        print(f"Proxy test failed: {e}")
        return False

def get_verification_status(channel_data):
    """Check if channel is verified based on badges in channel data"""
    badges = channel_data.get('badges', [])
    for badge in badges:
        if badge and isinstance(badge, dict) and 'verified' in badge.get('type', '').lower():
            return True
    return False

@app.route('/api/video-info', methods=['GET'])
def get_video_info():
    """
    Get video information including available formats

    Query parameters:
    - url: YouTube video URL

    Returns:
    - Video information including title, thumbnail, channel info, and available formats with direct download links
    """
    url = request.args.get('url')
    if not url:
        return jsonify({"error": "Missing video URL"}), 400

    try:
        ydl_opts = get_base_ydl_opts()

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            video_id = info.get('id')

            # Extract relevant information
            result = {
                "id": video_id,
                "title": info.get('title'),
                "description": info.get('description'),
                "duration": info.get('duration'),
                "view_count": info.get('view_count'),
                "like_count": info.get('like_count'),
                "upload_date": info.get('upload_date'),
                "thumbnails": info.get('thumbnails', []),
                "channel": {
                    "id": info.get('channel_id'),
                    "name": info.get('channel', info.get('uploader')),
                    "url": info.get('channel_url'),
                    "profile_picture": None,
                    "verified": get_verification_status(info)
                },
                "audio_formats": [],
                "video_formats": []
            }

            # Try to extract channel profile picture if available
            for thumbnail in info.get('thumbnails', []):
                if 'url' in thumbnail and 'avatar' in thumbnail.get('id', ''):
                    result['channel']['profile_picture'] = thumbnail['url']
                    break

            # Extract audio formats
            audio_formats = []
            for format in info.get('formats', []):
                if format.get('vcodec') == 'none' and format.get('acodec') != 'none':
                    audio_formats.append({
                        "format_id": format.get('format_id'),
                        "ext": format.get('ext'),
                        "filesize": format.get('filesize'),
                        "format_note": format.get('format_note'),
                        "abr": format.get('abr'),
                        "download_url": f"/api/direct-download/{video_id}/{format.get('format_id')}"
                    })

            result["audio_formats"] = audio_formats

            # Extract video formats with direct download links
            video_formats = []
            for format in info.get('formats', []):
                if format.get('vcodec') != 'none':
                    video_formats.append({
                        "format_id": format.get('format_id'),
                        "ext": format.get('ext'),
                        "filesize": format.get('filesize'),
                        "format_note": format.get('format_note'),
                        "width": format.get('width'),
                        "height": format.get('height'),
                        "fps": format.get('fps'),
                        "vcodec": format.get('vcodec'),
                        "acodec": format.get('acodec'),
                        "download_url": f"/api/direct-download/{video_id}/{format.get('format_id')}",
                        "resolution": f"{format.get('width', 0)}x{format.get('height', 0)}"
                    })

            result["video_formats"] = video_formats

            return jsonify(result)

    except Exception as e:
        print(f"Error in get_video_info: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/download', methods=['GET'])
def download_video():
    """
    Download a video and combine with best audio

    Query parameters:
    - url: YouTube video URL
    - format_id: (Optional) Specific video format ID to download
    - audio_id: (Optional) Specific audio format ID to download

    Returns:
    - Download ID to check status
    """
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
    """Process video download and merging in background"""
    downloads_in_progress[download_id] = {
        "status": "downloading",
        "progress": 0,
        "url": url,
        "start_time": time.time()
    }

    try:
        output_filename = f"{download_id}.mp4"
        output_path = os.path.join(DOWNLOAD_FOLDER, output_filename)

        # Configure yt-dlp options
        ydl_opts = get_base_ydl_opts()
        ydl_opts.update({
            'outtmpl': os.path.join(TEMP_FOLDER, f"{download_id}_%(title)s.%(ext)s"),
            'progress_hooks': [lambda d: update_progress(download_id, d)],
        })

        # If specific format requested
        if format_id:
            if audio_id:
                # Download video and audio separately and merge
                video_path = download_specific_format(url, format_id, f"{download_id}_video")
                audio_path = download_specific_format(url, audio_id, f"{download_id}_audio")

                # Merge video and audio
                merge_video_audio(video_path, audio_path, output_path)

                # Clean up temp files
                if os.path.exists(video_path):
                    os.remove(video_path)
                if os.path.exists(audio_path):
                    os.remove(audio_path)

            else:
                # Download specific format and merge with best audio
                ydl_opts.update({
                    'format': f"{format_id}+bestaudio/best",
                    'merge_output_format': 'mp4',
                })

                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(url)
                    downloaded_file = ydl.prepare_filename(info)

                    # Find the actual downloaded file
                    actual_file = find_downloaded_file(downloaded_file)
                    if actual_file and os.path.exists(actual_file):
                        os.rename(actual_file, output_path)
        else:
            # Download best quality and merge
            ydl_opts.update({
                'format': 'bestvideo+bestaudio/best',
                'merge_output_format': 'mp4',
            })

            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url)
                downloaded_file = ydl.prepare_filename(info)

                # Find the actual downloaded file
                actual_file = find_downloaded_file(downloaded_file)
                if actual_file and os.path.exists(actual_file):
                    os.rename(actual_file, output_path)

        # Update download info
        completed_downloads[download_id] = {
            "status": "completed",
            "url": url,
            "file_path": output_path,
            "download_url": f"/api/get-file/{download_id}",
            "completion_time": time.time()
        }

    except Exception as e:
        print(f"Error in process_download: {e}")
        completed_downloads[download_id] = {
            "status": "failed",
            "url": url,
            "error": str(e),
            "completion_time": time.time()
        }

    finally:
        # Remove from in-progress
        if download_id in downloads_in_progress:
            downloads_in_progress.pop(download_id)

def find_downloaded_file(base_filename):
    """Find the actual downloaded file with various possible extensions"""
    if os.path.exists(base_filename):
        return base_filename
    
    # Try different extensions
    base_no_ext = base_filename.rsplit(".", 1)[0]
    for ext in ['mp4', 'webm', 'mkv', 'm4a', 'mp3', 'f4v']:
        candidate = f"{base_no_ext}.{ext}"
        if os.path.exists(candidate):
            return candidate
    
    return None

def download_specific_format(url, format_id, prefix):
    """Download specific format and return file path"""
    ydl_opts = get_base_ydl_opts()
    ydl_opts.update({
        'format': format_id,
        'outtmpl': os.path.join(TEMP_FOLDER, f"{prefix}.%(ext)s"),
    })

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url)
        downloaded_file = ydl.prepare_filename(info)
        return find_downloaded_file(downloaded_file)

def merge_video_audio(video_path, audio_path, output_path):
    """Merge video and audio files using ffmpeg"""
    import subprocess

    try:
        command = [
            'ffmpeg', '-y',  # Overwrite output file
            '-i', video_path, '-i', audio_path,
            '-c:v', 'copy', '-c:a', 'aac', '-strict', 'experimental',
            '-avoid_negative_ts', 'make_zero',
            output_path
        ]

        result = subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        return True
    except subprocess.CalledProcessError as e:
        print(f"FFmpeg error: {e.stderr}")
        return False
    except Exception as e:
        print(f"Error merging files: {e}")
        return False

def update_progress(download_id, d):
    """Update download progress information"""
    if download_id in downloads_in_progress:
        if d['status'] == 'downloading':
            try:
                percent_str = d.get('_percent_str', '0%')
                if percent_str and percent_str != 'N/A':
                    downloads_in_progress[download_id]['progress'] = float(percent_str.replace('%', ''))
            except (ValueError, AttributeError):
                pass
        elif d['status'] == 'finished':
            downloads_in_progress[download_id]['status'] = 'processing'
            downloads_in_progress[download_id]['progress'] = 100

@app.route('/api/download-status/<download_id>', methods=['GET'])
def check_download_status(download_id):
    """
    Check the status of a download

    Path parameters:
    - download_id: ID of the download to check

    Returns:
    - Download status information
    """
    # Check if download is in progress
    if download_id in downloads_in_progress:
        return jsonify({
            "download_id": download_id,
            "status": downloads_in_progress[download_id]["status"],
            "progress": downloads_in_progress[download_id]["progress"],
            "url": downloads_in_progress[download_id]["url"]
        })

    # Check if download is completed
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
    """
    Get a downloaded file

    Path parameters:
    - download_id: ID of the download to get

    Returns:
    - The downloaded file
    """
    if download_id in completed_downloads and completed_downloads[download_id]["status"] == "completed":
        file_path = completed_downloads[download_id]["file_path"]

        if os.path.exists(file_path):
            filename = os.path.basename(file_path)
            return send_file(file_path, as_attachment=True, download_name=filename)

    return jsonify({"error": "File not found"}), 404

@app.route('/api/direct-download/<video_id>/<format_id>', methods=['GET'])
def direct_download(video_id, format_id):
    """
    Direct download endpoint that combines video with best audio and sends the file

    Path parameters:
    - video_id: YouTube video ID
    - format_id: Format ID to download

    Query parameters:
    - audio_id: (Optional) Specific audio format ID
    - filename: (Optional) Custom filename for the download

    Returns:
    - The downloaded file directly to the browser
    """
    audio_id = request.args.get('audio_id')
    custom_filename = request.args.get('filename')
    url = f"https://www.youtube.com/watch?v={video_id}"

    try:
        # Create a unique filename based on video ID and format
        filename = f"{video_id}_{format_id}"
        if audio_id:
            filename += f"_{audio_id}"
        filename += ".mp4"

        output_path = os.path.join(DOWNLOAD_FOLDER, filename)

        # Check if file already exists (cached)
        if os.path.exists(output_path):
            download_name = custom_filename if custom_filename else f"{video_id}.mp4"
            return send_file(output_path, as_attachment=True, download_name=download_name)

        # Set up download options
        ydl_opts = get_base_ydl_opts()

        # Add progress hooks
        download_id = str(uuid.uuid4())
        downloads_in_progress[download_id] = {
            "status": "downloading",
            "progress": 0,
            "url": url,
            "start_time": time.time()
        }

        ydl_opts.update({
            'progress_hooks': [lambda d: update_progress(download_id, d)],
            'outtmpl': output_path,
        })

        # Configure format selection
        if audio_id:
            format_selector = f"{format_id}+{audio_id}"
        else:
            # Check if format is audio-only or video-only
            with yt_dlp.YoutubeDL(get_base_ydl_opts()) as ydl:
                info = ydl.extract_info(url, download=False)
                target_format = None
                for fmt in info.get('formats', []):
                    if fmt.get('format_id') == format_id:
                        target_format = fmt
                        break
                
                if target_format and target_format.get('acodec') == 'none':
                    # Video-only format, combine with best audio
                    format_selector = f"{format_id}+bestaudio"
                else:
                    # Audio-only or combined format
                    format_selector = format_id

        ydl_opts.update({
            'format': format_selector,
            'merge_output_format': 'mp4',
        })

        # Download the file
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url)

            # Get the actual title for a better filename if not provided
            if not custom_filename and info.get('title'):
                video_title = info.get('title')
                # Clean the title for use as a filename
                video_title = ''.join(c for c in video_title if c.isalnum() or c in ' ._-')
                download_name = f"{video_title}.mp4"
            else:
                download_name = custom_filename if custom_filename else f"{video_id}.mp4"

        # Update downloads info and remove from in-progress
        if download_id in downloads_in_progress:
            downloads_in_progress.pop(download_id)

        completed_downloads[download_id] = {
            "status": "completed",
            "url": url,
            "file_path": output_path,
            "completion_time": time.time()
        }

        # Find the actual downloaded file
        actual_file = find_downloaded_file(output_path)
        if actual_file and os.path.exists(actual_file):
            # If the file was downloaded with a different name, rename it
            if actual_file != output_path:
                os.rename(actual_file, output_path)
            return send_file(output_path, as_attachment=True, download_name=download_name)
        else:
            return jsonify({"error": "Download failed - file not found"}), 500

    except Exception as e:
        print(f"Error in direct_download: {e}")
        # Clean up progress tracking
        if download_id in downloads_in_progress:
            downloads_in_progress.pop(download_id)
        return jsonify({"error": str(e)}), 500

@app.route('/api/proxy-test', methods=['GET'])
def test_proxy():
    """Test if the ScraperAPI proxy is working"""
    try:
        response = requests.get('https://youtube.com', 
                              proxies=SCRAPERAPI_PROXY, 
                              verify=False, 
                              timeout=10,
                              headers={
                                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                              })
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
    """Simple health check endpoint"""
    proxy_status = test_proxy_connection()
    return jsonify({
        "status": "ok",
        "version": "1.0.1",
        "proxy_working": proxy_status,
        "proxy_config": "ScraperAPI enabled with SSL bypass"
    })

if __name__ == '__main__':
    # Test proxy connection on startup
    print("Testing ScraperAPI proxy connection...")
    if test_proxy_connection():
        print("✓ Proxy connection successful")
    else:
        print("✗ Proxy connection failed - downloads may not work properly")
    
    # For Replit, use this configuration
    app.run(host='0.0.0.0', port=8080)
