# Square Orders Fetcher

This Python script fetches the 30 most recent orders from the Square API.

## Requirements

- Python 3.6 or higher
- Square Developer account
- Square API credentials (Application ID and Access Token)
- Square Location ID

## Setup

1. Install the required dependencies:
   ```
   pip install -r requirements.txt
   ```

2. Obtain your Square API credentials:
   - Go to the [Square Developer Dashboard](https://developer.squareup.com/apps)
   - Create a new application or select an existing one
   - Copy your Application ID and Access Token

3. Find your Square Location ID:
   - In the Square Developer Dashboard, go to the Locations page
   - Copy the Location ID for the location you want to fetch orders from

4. Update the script with your credentials:
   - Open `square_orders.py`
   - Replace `YOUR_APPLICATION_ID_HERE` with your actual Application ID
   - Replace `YOUR_ACCESS_TOKEN_HERE` with your actual Access Token
   - Replace `YOUR_LOCATION_ID_HERE` with your actual Location ID

## Usage

Run the script:
```
python square_orders.py
```

## Notes

- The script is configured to use the production Square API by default
- To use the sandbox environment for testing, change `SQUARE_ENVIRONMENT` to `"sandbox"`
- Square API version is set to the current date (2025-08-23) but can be adjusted as needed
