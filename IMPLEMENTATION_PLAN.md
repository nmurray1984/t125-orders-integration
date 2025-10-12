# Implementation Plan: Nightly Google Sheets Update

## 1. Google Sheets Integration

### Required Changes:
- Add `google-auth`, `google-auth-oauthlib`, `google-auth-httplib2`, and `google-api-python-client` to requirements.txt
- Create new function `write_to_google_sheet()` that:
  - Authenticates using service account credentials
  - Clears existing sheet data (or appends to preserve history)
  - Writes CSV data to specified sheet/range
  - Handles API rate limits and retries

### Authentication:
- Use Google Service Account (recommended for automation)
- Store service account JSON credentials securely
- Share target Google Sheet with service account email
- Requires: `GOOGLE_CREDENTIALS_JSON` environment variable

## 2. Scheduling

### GitHub Actions
- Add `.github/workflows/nightly-sync.yml`
- Cron schedule: `0 6 * * *` (6 AM UTC daily)
- Store secrets in GitHub Secrets

## 3. Configuration Management

### Environment Variables to Add:
- `SQUARE_ACCESS_TOKEN` (move from hardcoded)
- `SQUARE_LOCATION_ID` (move from hardcoded)
- `GOOGLE_SHEET_ID` (target spreadsheet)
- `GOOGLE_CREDENTIALS_JSON` (service account credentials)
- `SHEET_NAME` (optional, default: "Sheet1")
- `WRITE_MODE` (optional: "overwrite" or "append")

### New Config File:
- Create `config.py` to centralize environment variable loading
- Add validation for required variables

## 4. Code Refactoring

### Modify square_orders.py:
- Refactor `create_dynamic_table()` to return data structure instead of printing
- Add new `write_to_google_sheet(data, sheet_id, credentials)` function
- Update `main()` to support both stdout and Google Sheets output modes
- Add `--output` CLI argument: `stdout` (default) or `sheets`

### Error Handling:
- Wrap API calls in try/except
- Log errors to stdout

## 5. Testing Strategy

### New Tests:
- `test_google_sheets_integration.py` with mocked Google API
- Test sheet writing (clear vs append modes)
- Test error handling

### Integration Test:
- Manual test run against test Google Sheet
- Verify data format and column headers
- Test with missing/malformed data

## 6. Monitoring & Alerts

### Logging:
- Log: execution time, record count, errors, API calls

### Notifications:
- Use GitHub Actions notifications on script failure

## 7. Documentation Updates

### Update CLAUDE.md:
- Add setup instructions for Google Sheets integration
- Document new environment variables
- Add scheduling configuration examples

### Create deployment guide:
- Step-by-step GitHub Actions setup
- Service account creation tutorial
- Troubleshooting common issues

---

## Recommended Implementation Order

1. Move hardcoded secrets to environment variables
2. Add Google Sheets API dependencies
3. Implement Google Sheets write function
4. Refactor main() for dual output modes
5. Create GitHub Actions workflow
6. Add comprehensive error handling
7. Write integration tests
8. Deploy and test end-to-end

**Estimated Time:** 4-6 hours for complete implementation and testing
