import json
import sys
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from config import Config


def get_sheets_service():
    """Create and return a Google Sheets API service instance"""
    try:
        # Parse credentials from environment variable
        credentials_info = json.loads(Config.GOOGLE_CREDENTIALS_JSON)

        # Create credentials object
        credentials = service_account.Credentials.from_service_account_info(
            credentials_info,
            scopes=['https://www.googleapis.com/auth/spreadsheets']
        )

        # Build and return the service
        service = build('sheets', 'v4', credentials=credentials)
        return service

    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON in GOOGLE_CREDENTIALS_JSON: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"Error creating Google Sheets service: {e}")
        sys.exit(1)


def write_to_google_sheet(data, sheet_id=None, sheet_name=None, write_mode='overwrite'):
    """
    Write data to a Google Sheet

    Args:
        data: List of dictionaries containing row data
        sheet_id: Google Sheet ID (defaults to Config.GOOGLE_SHEET_ID)
        sheet_name: Sheet name/tab (defaults to Config.SHEET_NAME)
        write_mode: 'overwrite' or 'append' (defaults to Config.WRITE_MODE)
    """
    if not data:
        print("No data to write to Google Sheets.")
        return False

    sheet_id = sheet_id or Config.GOOGLE_SHEET_ID
    sheet_name = sheet_name or Config.SHEET_NAME
    write_mode = write_mode or Config.WRITE_MODE

    try:
        service = get_sheets_service()

        # Define headers matching the CSV output
        headers = ['Order ID', 'Total Money', 'Line Item Name', 'Name', 'Rank', 'Patrol',
                   'Emergency Contact', 'Emergency Contact Phone', 'Cell Phone', 'Travel to Campout']

        # Prepare rows
        rows = [headers]
        for row_data in data:
            # Combine scout_name and scouter_name into a single Name field
            name = row_data['scout_name'] if row_data['scout_name'] else row_data['scouter_name']
            patrol = row_data['patrol'] if row_data['patrol'] else 'Rocking Chair'

            row = [
                row_data['order_id'],
                row_data['total_money'],
                row_data['line_item_name'],
                name,
                row_data['rank'],
                patrol,
                row_data['emergency_contact'],
                row_data['emergency_contact_phone'],
                row_data['cell_phone'],
                row_data['travel_to_campout']
            ]
            rows.append(row)

        if write_mode == 'overwrite':
            # Clear existing data and write new data
            range_name = f'{sheet_name}!A1'

            # Clear the sheet first
            service.spreadsheets().values().clear(
                spreadsheetId=sheet_id,
                range=sheet_name
            ).execute()

            # Write new data
            body = {
                'values': rows
            }

            result = service.spreadsheets().values().update(
                spreadsheetId=sheet_id,
                range=range_name,
                valueInputOption='RAW',
                body=body
            ).execute()

            print(f"Successfully wrote {result.get('updatedCells')} cells to Google Sheet (overwrite mode)")
            print(f"Sheet URL: https://docs.google.com/spreadsheets/d/{sheet_id}")
            return True

        elif write_mode == 'append':
            # Append data (without headers if sheet already has data)
            range_name = f'{sheet_name}!A1'

            # Check if sheet has existing data
            try:
                existing = service.spreadsheets().values().get(
                    spreadsheetId=sheet_id,
                    range=range_name
                ).execute()
                has_data = bool(existing.get('values'))
            except HttpError:
                has_data = False

            # If sheet has data, skip the header row
            if has_data:
                rows = rows[1:]  # Remove header row

            body = {
                'values': rows
            }

            result = service.spreadsheets().values().append(
                spreadsheetId=sheet_id,
                range=range_name,
                valueInputOption='RAW',
                body=body
            ).execute()

            print(f"Successfully appended {result.get('updates', {}).get('updatedCells', 0)} cells to Google Sheet")
            print(f"Sheet URL: https://docs.google.com/spreadsheets/d/{sheet_id}")
            return True

        else:
            print(f"Error: Invalid write_mode '{write_mode}'. Must be 'overwrite' or 'append'.")
            return False

    except HttpError as e:
        error_details = json.loads(e.content.decode('utf-8'))
        print(f"Google Sheets API error: {error_details.get('error', {}).get('message', str(e))}")
        print(f"Make sure the sheet ID is correct and the service account has access to the sheet.")
        return False

    except Exception as e:
        print(f"Error writing to Google Sheet: {e}")
        return False
