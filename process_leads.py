import pandas as pd
import os

def process_leads():
    # File paths
    reg_file = 'registrations.csv'
    scans_file = 'scans.csv'
    
    # Check if files exist
    if not os.path.exists(reg_file):
        print(f"Error: {reg_file} not found.")
        return
    if not os.path.exists(scans_file):
        print(f"Error: {scans_file} not found.")
        return

    try:
        # Load data
        print("Loading data...")
        # Assuming registrations.csv has 'UUID', 'Name', 'Email', 'University', etc.
        registrations = pd.read_csv(reg_file)
        
        # Assuming scans.csv has 'Timestamp', 'UUID' (downloaded from Google Sheet)
        scans = pd.read_csv(scans_file)

        # Basic cleaning - ensure UUIDs are strings to match
        registrations['UUID'] = registrations['UUID'].astype(str)
        scans['UUID'] = scans['UUID'].astype(str)

        # Filter out invalid scans if needed
        # scans = scans.dropna(subset=['UUID'])

        # Join data
        print("Joining data...")
        # Left join on scans to keep all scans even if registration missing (or inner to only keep valid?)
        # Let's do inner join to ensure we have lead details
        merged_data = pd.merge(scans, registrations, on='UUID', how='inner')
        
        if merged_data.empty:
            print("No matching records found after merge.")
            return

        # Group by University and Export
        print("Exporting per University...")
        
        # Check if 'University' column exists
        if 'University' not in merged_data.columns:
             # Fallback: Just export one file if no university segment found
             print("Warning: 'University' column not found in merged data. Exporting all to 'export_all.csv'")
             merged_data.to_csv('export_all.csv', index=False)
             return

        universities = merged_data['University'].unique()
        
        for uni in universities:
            uni_clean = str(uni).strip().replace(' ', '_').replace('/', '-')
            uni_df = merged_data[merged_data['University'] == uni]
            
            output_filename = f"export_{uni_clean}.csv"
            uni_df.to_csv(output_filename, index=False)
            print(f"Created: {output_filename} ({len(uni_df)} rows)")

        print("Done.")

    except Exception as e:
        print(f"An error occurred: {e}")

if __name__ == "__main__":
    process_leads()
