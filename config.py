import os
import sys
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

class Config:
    """Configuration management for Square and Google Sheets integration"""

    # Square API Configuration
    SQUARE_ACCESS_TOKEN = os.getenv('SQUARE_ACCESS_TOKEN', '')
    SQUARE_LOCATION_ID = os.getenv('SQUARE_LOCATION_ID', '')
    SQUARE_FETCH_LIMIT = int(os.getenv('SQUARE_FETCH_LIMIT', '70'))

    # Google Sheets Configuration
    GOOGLE_SHEET_ID = os.getenv('GOOGLE_SHEET_ID', '')
    GOOGLE_CREDENTIALS_JSON = os.getenv('GOOGLE_CREDENTIALS_JSON', '')
    SHEET_NAME = os.getenv('SHEET_NAME', 'Sheet1')
    WRITE_MODE = os.getenv('WRITE_MODE', 'overwrite')  # 'overwrite' or 'append'

    @classmethod
    def validate_square_config(cls):
        """Validate required Square API configuration"""
        if not cls.SQUARE_ACCESS_TOKEN:
            print("Error: SQUARE_ACCESS_TOKEN is required")
            sys.exit(1)
        if not cls.SQUARE_LOCATION_ID:
            print("Error: SQUARE_LOCATION_ID is required")
            sys.exit(1)

    @classmethod
    def validate_google_sheets_config(cls):
        """Validate required Google Sheets configuration"""
        if not cls.GOOGLE_SHEET_ID:
            print("Error: GOOGLE_SHEET_ID environment variable is required for Google Sheets output")
            sys.exit(1)
        if not cls.GOOGLE_CREDENTIALS_JSON:
            print("Error: GOOGLE_CREDENTIALS_JSON environment variable is required for Google Sheets output")
            sys.exit(1)
        if cls.WRITE_MODE not in ['overwrite', 'append']:
            print(f"Error: WRITE_MODE must be 'overwrite' or 'append', got '{cls.WRITE_MODE}'")
            sys.exit(1)
