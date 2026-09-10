import unittest
from unittest.mock import Mock, patch
from xml.etree import ElementTree as ET

from jarvizar_city_model.external.lidar_metadata import fgdc_metadata, read_report, xml_root


class SurveyXMLTests(unittest.TestCase):
    def test_fgdc_external_doctype_is_ignored_and_acquisition_is_read(self):
        report = '''<?xml version="1.0"?>
        <!DOCTYPE metadata SYSTEM "http://example.invalid/fgdc.dtd">
        <metadata xmlns="urn:fgdc"><idinfo><citation><citeinfo>
        <title>County &amp; regional survey</title><pubdate>2026</pubdate>
        </citeinfo></citation><timeperd><timeinfo><rngdates>
        <begdate>20170416</begdate><enddate>20170507</enddate>
        </rngdates></timeinfo><current>ground condition</current></timeperd>
        <descript><abstract>Nominal pulse spacing (NPS) of 0.35 meters.</abstract>
        </descript></idinfo></metadata>'''
        for encoding in ('utf-8-sig', 'utf-16'):
            fetch = Mock(get=Mock(return_value=report.encode(encoding)))
            with patch('urllib.request.urlopen', side_effect=AssertionError('No DTD requests')):
                meta = read_report(fetch, 'https://example.com/survey.xml', identities={})
            self.assertEqual(meta['acquisition_start'], '2017-04-16')
            self.assertEqual(meta['acquisition_end'], '2017-05-07')
            self.assertEqual(meta['point_spacing_m'], .35)
            fetch.get.assert_called_once()
            fetch.download.assert_not_called()

    def test_custom_internal_external_and_parameter_entities_are_rejected(self):
        declarations = ('<!ENTITY a "expanded">',
                        '<!ENTITY a SYSTEM "file:///private.txt">',
                        '<!ENTITY % a SYSTEM "https://example.com/entities.dtd">%a;')
        for encoding in ('utf-8', 'utf-16', 'utf-16-be'):
            for declaration in declarations:
                with self.subTest(encoding=encoding, declaration=declaration):
                    report = f'<!DOCTYPE metadata [{declaration}]><metadata>&a;</metadata>'
                    with self.assertRaises(ValueError):
                        fgdc_metadata(report.encode(encoding))

    def test_missing_external_entity_is_not_silently_omitted(self):
        for element in ('<metadata>&missing;</metadata>', '<metadata value="&missing;"/>'):
            for encoding in ('utf-8', 'utf-16'):
                with self.assertRaises(ValueError):
                    xml_root(('<!DOCTYPE metadata SYSTEM "https://example.com/a.dtd">' + element).encode(encoding))

    def test_comments_are_text_and_malformed_xml_remains_an_error(self):
        root = xml_root(b'<metadata><!-- <!ENTITY not-a-declaration> --><value>&lt;safe&gt;</value></metadata>')
        self.assertEqual(root.findtext('value'), '<safe>')
        root = xml_root(b'<metadata value="&amp;&#65;"><![CDATA[<fake value="&text;"/>]]></metadata>')
        self.assertEqual(root.attrib['value'], '&A')
        self.assertEqual(root.text, '<fake value="&text;"/>')
        with self.assertRaises(ET.ParseError):
            xml_root(b'<metadata>')
