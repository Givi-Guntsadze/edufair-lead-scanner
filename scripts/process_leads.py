"""
EduFair Lead Scanner - Post-Event Processing Script
====================================================
This script performs the "Split & Delivery" operation after the event ends.

INPUTS:
  - registrations.csv: Export from your "Lead Registrations" Google Sheet
  - raw_scans.csv: Export from the "Raw_Scans" tab

OUTPUT:
  - leads_HARVARD.csv, leads_YALE.csv, etc. (one per university)
"""

import pandas as pd
import os
import sys
from datetime import datetime

def load_data(reg_file: str, scans_file: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Load and validate the input CSV files."""
    
    # Check files exist
    if not os.path.exists(reg_file):
        print(f"❌ Error: {reg_file} not found")
        print("   Export your Registration Sheet from Google Sheets as CSV")
        sys.exit(1)
        
    if not os.path.exists(scans_file):
        print(f"❌ Error: {scans_file} not found")
        print("   Export the Raw_Scans tab from Google Sheets as CSV")
        sys.exit(1)
    
    registrations = pd.read_csv(reg_file)
    scans = pd.read_csv(scans_file)
    
    print(f"✓ Loaded {len(registrations)} registrations")
    print(f"✓ Loaded {len(scans)} scans")
    
    return registrations, scans

def clean_data(registrations: pd.DataFrame, scans: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Standardize column names and clean data."""
    
    # Normalize column names (strip whitespace, lowercase)
    registrations.columns = registrations.columns.str.strip()
    scans.columns = scans.columns.str.strip()
    
    # Find the UUID column in registrations (might be 'ticket_id', 'UUID', 'uuid', etc.)
    uuid_col = None
    for col in registrations.columns:
        if col.lower() in ['ticket_id', 'uuid', 'ticketid', 'id']:
            uuid_col = col
            break
    
    if not uuid_col:
        print("❌ Error: Could not find UUID column in registrations")
        print(f"   Available columns: {list(registrations.columns)}")
        sys.exit(1)
    
    # Standardize UUID column name
    registrations = registrations.rename(columns={uuid_col: 'UUID'})
    
    # Ensure UUID columns are strings
    registrations['UUID'] = registrations['UUID'].astype(str).str.strip().str.upper()
    scans['UUID'] = scans['UUID'].astype(str).str.strip().str.upper()
    
    # Remove unicode replacement characters (common encoding issue)
    for df in [registrations, scans]:
        for col in df.select_dtypes(include=['object']).columns:
            df[col] = df[col].apply(lambda x: str(x).replace('\ufffd', '') if pd.notna(x) else x)
    
    print(f"✓ Data cleaned (UUID column: '{uuid_col}')")
    
    return registrations, scans

def merge_data(registrations: pd.DataFrame, scans: pd.DataFrame) -> pd.DataFrame:
    """Join scans with registration data."""
    
    merged = pd.merge(
        scans,
        registrations,
        on='UUID',
        how='left'
    )
    
    # Check for unmatched scans
    unmatched = merged[merged['Name'].isna() if 'Name' in merged.columns else merged.iloc[:, 0].isna()]
    if len(unmatched) > 0:
        print(f"⚠️  Warning: {len(unmatched)} scans could not be matched to registrations")
    
    print(f"✓ Merged data: {len(merged)} records")
    
    return merged

def generate_reports(merged: pd.DataFrame, output_dir: str = 'reports'):
    """Generate one CSV file per university."""
    
    # Create output directory
    os.makedirs(output_dir, exist_ok=True)
    
    # Get unique universities
    if 'Uni_ID' not in merged.columns:
        print("❌ Error: 'Uni_ID' column not found in scans data")
        sys.exit(1)
    
    universities = merged['Uni_ID'].dropna().unique()
    print(f"\n📊 Generating reports for {len(universities)} universities...\n")
    
    # Define columns to include in reports
    # Prioritize common registration fields, exclude internal IDs
    priority_columns = [
        'Name', 'Last Name', 'Email', 'Phone',
        'Which programs?', 'Intake Year', 'Country',
        'Additional Info', 'Consent (to receive communication)',
        # Fallbacks
        'name', 'email', 'phone'
    ]
    
    # Find which columns actually exist
    export_columns = [col for col in priority_columns if col in merged.columns]
    
    if not export_columns:
        # Fallback: use all columns except internal ones
        exclude = ['UUID', 'Uni_ID', 'Timestamp', 'uuid', 'ticket_id']
        export_columns = [col for col in merged.columns if col not in exclude]
    
    print(f"   Exporting columns: {export_columns}\n")
    
    # Generate report for each university
    total_leads = 0
    for uni in sorted(universities):
        uni_data = merged[merged['Uni_ID'] == uni]
        
        # Clean filename
        uni_clean = str(uni).strip().replace(' ', '_').replace('/', '-')
        filename = os.path.join(output_dir, f"leads_{uni_clean}.csv")
        
        # Export
        report = uni_data[export_columns].drop_duplicates()
        report.to_csv(filename, index=False, encoding='utf-8')
        
        print(f"   ✓ {uni}: {len(report)} leads → {filename}")
        total_leads += len(report)
    
    print(f"\n✅ Done! Generated {len(universities)} reports with {total_leads} total leads.")
    print(f"   Output folder: {os.path.abspath(output_dir)}")

def main():
    print("\n" + "="*60)
    print("  EduFair Lead Scanner - Post-Event Processing")
    print("="*60 + "\n")
    
    # Default file names
    reg_file = 'registrations.csv'
    scans_file = 'raw_scans.csv'
    
    # Allow command-line override
    if len(sys.argv) >= 3:
        reg_file = sys.argv[1]
        scans_file = sys.argv[2]
    
    print(f"📁 Registration file: {reg_file}")
    print(f"📁 Scans file: {scans_file}\n")
    
    # Process
    registrations, scans = load_data(reg_file, scans_file)
    registrations, scans = clean_data(registrations, scans)
    merged = merge_data(registrations, scans)
    generate_reports(merged)

if __name__ == "__main__":
    main()
