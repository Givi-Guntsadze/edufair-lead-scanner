import importlib.util
import tempfile
import unittest
import warnings
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "process_leads.py"
SPEC = importlib.util.spec_from_file_location("process_leads", MODULE_PATH)
process_leads = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(process_leads)


class ProcessLeadsTest(unittest.TestCase):
    def test_clean_data_has_no_pandas_dtype_compatibility_warnings(self):
        registrations = pd.DataFrame(
            [{"Name": "Ana", "UUID": "A1B2C3D4"}]
        )
        scans = pd.DataFrame(
            [{"Timestamp": "2026-07-31T11:00:00Z", "Uni_ID": "SRH", "UUID": "A1B2C3D4"}]
        )

        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            process_leads.clean_data(registrations, scans)

        self.assertEqual(caught, [])

    def test_new_registration_schema_exports_age_and_consent(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            registrations_path = temp_path / "registrations.csv"
            scans_path = temp_path / "raw_scans.csv"
            reports_path = temp_path / "reports"

            registrations_path.write_text(
                "timestamp,Name,Last Name,Email,Phone,Which programs?,Age,Intake Year\t,\tCountry,\tAdditional Info,Consent,UUID\n"
                "2026-07-31T10:00:00Z,Ana,Beridze,ana@example.com,+995555000000,Masters,24,2027,Georgia,Call after 5pm,TRUE,A1B2C3D4\n",
                encoding="utf-8",
            )
            scans_path.write_text(
                "Timestamp,Uni_ID,UUID\n"
                "2026-07-31T11:00:00Z,SRH,A1B2C3D4\n",
                encoding="utf-8",
            )

            registrations, scans = process_leads.load_data(
                str(registrations_path), str(scans_path)
            )
            registrations, scans = process_leads.clean_data(registrations, scans)
            merged = process_leads.merge_data(registrations, scans)
            process_leads.generate_reports(merged, str(reports_path))

            report = pd.read_csv(reports_path / "leads_SRH.csv")

            self.assertEqual(
                list(report.columns),
                [
                    "Name",
                    "Last Name",
                    "Email",
                    "Phone",
                    "Which programs?",
                    "Age",
                    "Intake Year",
                    "Country",
                    "Additional Info",
                    "Consent",
                ],
            )
            self.assertEqual(report.loc[0, "Age"], 24)
            self.assertTrue(report.loc[0, "Consent"])

    def test_report_includes_which_fair_for_both_cities(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            registrations_path = temp_path / "registrations.csv"
            scans_path = temp_path / "raw_scans.csv"
            reports_path = temp_path / "reports"

            registrations_path.write_text(
                "timestamp,Name,Last Name,Email,Phone,Which programs?,Age,Intake Year,Country,Which Fair,Additional Info,Consent,UUID\n"
                "2026-10-01T10:00:00Z,Ana,Beridze,ana@example.com,+995555000001,Masters,24,2027,Georgia,Tbilisi,Call after 5pm,TRUE,A1B2C3D4\n"
                "2026-10-01T10:05:00Z,Nino,Gelashvili,nino@example.com,+995555000002,Bachelors,18,2027,Georgia,Batumi,Email only,TRUE,E5F6G7H8\n",
                encoding="utf-8",
            )
            scans_path.write_text(
                "Timestamp,Uni_ID,UUID\n"
                "2026-10-03T11:00:00Z,SRH,A1B2C3D4\n"
                "2026-10-03T11:01:00Z,SRH,E5F6G7H8\n",
                encoding="utf-8",
            )

            registrations, scans = process_leads.load_data(
                str(registrations_path), str(scans_path)
            )
            registrations, scans = process_leads.clean_data(registrations, scans)
            merged = process_leads.merge_data(registrations, scans)
            process_leads.generate_reports(merged, str(reports_path))

            report_files = list(reports_path.glob("leads_*.csv"))
            self.assertEqual(
                [path.name for path in report_files],
                ["leads_SRH.csv"],
            )

            report = pd.read_csv(report_files[0])
            self.assertEqual(len(report), 2)
            self.assertEqual(
                report["Which Fair"].tolist(),
                ["Tbilisi", "Batumi"],
            )
            columns = list(report.columns)
            self.assertEqual(
                columns[columns.index("Country") : columns.index("Additional Info") + 1],
                ["Country", "Which Fair", "Additional Info"],
            )


if __name__ == "__main__":
    unittest.main()
