import os
import sys
from urllib.parse import urlparse

from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

class Config:
    """Configuration management for Square and Google Sheets integration"""

    # Square API Configuration
    SQUARE_ACCESS_TOKEN = os.getenv('SQUARE_ACCESS_TOKEN', '')
    SQUARE_LOCATION_ID = os.getenv('SQUARE_LOCATION_ID', '')
    SQUARE_FETCH_LIMIT = int(os.getenv('SQUARE_FETCH_LIMIT', '70'))

    # Sandbox credentials live alongside the production ones so switching
    # environments is a flag, not an edit to .env. Square issues separate
    # tokens AND separate location IDs per environment -- they are not
    # interchangeable.
    SQUARE_SANDBOX_ACCESS_TOKEN = os.getenv('SQUARE_SANDBOX_ACCESS_TOKEN', '')
    SQUARE_SANDBOX_LOCATION_ID = os.getenv('SQUARE_SANDBOX_LOCATION_ID', '')

    # Default environment when no --square-env flag is given. Deliberately
    # sandbox: hitting production should be something you asked for.
    SQUARE_ENVIRONMENT = os.getenv('SQUARE_ENVIRONMENT', 'sandbox')

    # Google Sheets Configuration
    GOOGLE_SHEET_ID = os.getenv('GOOGLE_SHEET_ID', '')
    GOOGLE_CREDENTIALS_JSON = os.getenv('GOOGLE_CREDENTIALS_JSON', '')
    SHEET_NAME = os.getenv('SHEET_NAME', 'Sheet1')
    WRITE_MODE = os.getenv('WRITE_MODE', 'overwrite')  # 'overwrite' or 'append'

    # Cloudflare D1 Configuration (via the roster Worker)
    D1_SYNC_URL = os.getenv('D1_SYNC_URL', '')
    D1_SYNC_TOKEN = os.getenv('D1_SYNC_TOKEN', '')

    @classmethod
    def square_credentials(cls, environment):
        """
        Resolve (token, location_id, source) for the chosen Square environment.

        Sandbox falls back to the generic vars when the sandbox-specific ones
        are unset, so someone who only has sandbox credentials can put them in
        SQUARE_ACCESS_TOKEN and still work. `source` names which vars were used
        so the caller can say so out loud.
        """
        if environment == 'production':
            return cls.SQUARE_ACCESS_TOKEN, cls.SQUARE_LOCATION_ID, 'SQUARE_ACCESS_TOKEN'

        if cls.SQUARE_SANDBOX_ACCESS_TOKEN:
            return (cls.SQUARE_SANDBOX_ACCESS_TOKEN,
                    cls.SQUARE_SANDBOX_LOCATION_ID or cls.SQUARE_LOCATION_ID,
                    'SQUARE_SANDBOX_ACCESS_TOKEN')

        return cls.SQUARE_ACCESS_TOKEN, cls.SQUARE_LOCATION_ID, 'SQUARE_ACCESS_TOKEN'

    @classmethod
    def validate_square_config(cls, environment='production'):
        """Validate required Square API configuration for an environment"""
        if environment not in ('sandbox', 'production'):
            print(f"Error: unknown Square environment '{environment}'")
            sys.exit(1)

        token, location_id, source = cls.square_credentials(environment)

        if not token:
            print(f"Error: {source} is required for the {environment} environment")
            sys.exit(1)
        if not location_id:
            location_var = ('SQUARE_SANDBOX_LOCATION_ID'
                            if source == 'SQUARE_SANDBOX_ACCESS_TOKEN'
                            else 'SQUARE_LOCATION_ID')
            print(f"Error: {location_var} is required for the {environment} environment")
            sys.exit(1)

        return token, location_id, source

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

    @classmethod
    def validate_d1_config(cls):
        """Validate required Cloudflare D1 configuration"""
        if not cls.D1_SYNC_URL:
            print("Error: D1_SYNC_URL environment variable is required for D1 output")
            sys.exit(1)
        if not cls.D1_SYNC_URL.startswith('https://') and not cls.is_local_sync_url():
            print("Error: D1_SYNC_URL must be an https:// URL "
                  "(the sync token is sent as a bearer header). "
                  "http is allowed only for a local Worker on localhost.")
            sys.exit(1)
        if not cls.D1_SYNC_TOKEN:
            print("Error: D1_SYNC_TOKEN environment variable is required for D1 output")
            sys.exit(1)

    # `wrangler dev` cannot serve https, so plain http is allowed when the
    # Worker is on this machine -- the bearer token never crosses a network.
    LOCAL_HOSTS = frozenset({'localhost', '127.0.0.1', '::1', '[::1]'})

    @classmethod
    def is_local_sync_url(cls, url=None):
        """True when D1_SYNC_URL points at a Worker running on this machine."""
        url = url if url is not None else cls.D1_SYNC_URL
        try:
            hostname = urlparse(url).hostname
        except ValueError:
            return False
        return hostname in cls.LOCAL_HOSTS
