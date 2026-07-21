package com.reflo.ingestion;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.awt.Color;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.font.Standard14Fonts;
import org.apache.poi.xwpf.usermodel.XWPFDocument;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

final class WorkerMainTest {
    @TempDir
    Path temporaryDirectory;

    @Test
    void parsesDigitalAndScannedPdfFixtures() throws Exception {
        Path digital = temporaryDirectory.resolve("digital.pdf");
        try (PDDocument document = new PDDocument()) {
            PDPage page = new PDPage();
            document.addPage(page);
            try (PDPageContentStream content = new PDPageContentStream(document, page)) {
                content.beginText();
                content.setFont(
                        new PDType1Font(Standard14Fonts.FontName.HELVETICA),
                        12);
                content.newLineAtOffset(72, 700);
                content.showText("This digitally generated page contains enough grounded text for extraction and provenance.");
                content.endText();
            }
            document.save(digital.toFile());
        }
        WorkerMain.Parsed digitalResult = WorkerMain.parsePdf(digital);
        assertEquals(1, digitalResult.pageCount());
        assertEquals("digital", digitalResult.scan().classification());
        assertTrue(digitalResult.blocks().size() >= 1);

        Path scanned = temporaryDirectory.resolve("scanned.pdf");
        try (PDDocument document = new PDDocument()) {
            PDPage page = new PDPage();
            document.addPage(page);
            try (PDPageContentStream content = new PDPageContentStream(document, page)) {
                content.setNonStrokingColor(Color.BLACK);
                content.addRect(30, 300, 500, 300);
                content.fill();
            }
            document.save(scanned.toFile());
        }
        WorkerMain.Parsed scannedResult = WorkerMain.parsePdf(scanned);
        assertEquals("scanned", scannedResult.scan().classification());
        assertEquals(1, scannedResult.scan().candidatePages().size());
    }

    @Test
    void parsesDocxWithoutInventingPages() throws Exception {
        Path docx = temporaryDirectory.resolve("fixture.docx");
        try (XWPFDocument document = new XWPFDocument();
                OutputStream output = Files.newOutputStream(docx)) {
            document.createParagraph().createRun().setText("Grounded DOCX lesson text");
            document.write(output);
        }
        WorkerMain.Parsed result = WorkerMain.parseDocx(docx);
        assertNull(result.pageCount());
        assertEquals("digital", result.scan().classification());
        assertTrue(result.blocks().size() >= 1);
    }

    @Test
    void parsesEpubWithoutInventingPages() throws Exception {
        Path epub = temporaryDirectory.resolve("fixture.epub");
        writeEpub(epub);
        WorkerMain.Parsed result = WorkerMain.parseEpub(epub);
        assertNull(result.pageCount());
        assertEquals("digital", result.scan().classification());
        assertEquals(2, result.blocks().size());
        assertEquals("Grounded EPUB lesson text", result.blocks().get(0).text());
        assertEquals("OPS/text/chapter.xhtml", result.blocks().get(0).locator().get("resource"));
        assertEquals(0, result.blocks().get(0).locator().get("spineItem"));
        assertEquals("OPS/appendix.xhtml", result.blocks().get(1).locator().get("resource"));
        assertEquals(1, result.blocks().get(1).locator().get("spineItem"));
    }

    private static void writeEpub(Path target) throws IOException {
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(target))) {
            ZipEntry mimetype = new ZipEntry("mimetype");
            mimetype.setMethod(ZipEntry.STORED);
            byte[] mediaType = "application/epub+zip".getBytes(StandardCharsets.UTF_8);
            java.util.zip.CRC32 checksum = new java.util.zip.CRC32();
            checksum.update(mediaType);
            mimetype.setSize(mediaType.length);
            mimetype.setCompressedSize(mediaType.length);
            mimetype.setCrc(checksum.getValue());
            zip.putNextEntry(mimetype);
            zip.write(mediaType);
            zip.closeEntry();
            add(zip, "META-INF/container.xml", """
                    <?xml version="1.0"?>
                    <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
                      <rootfiles><rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
                    </container>
                    """);
            add(zip, "OPS/content.opf", """
                    <?xml version="1.0" encoding="UTF-8"?>
                    <package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id">
                      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">fixture</dc:identifier><dc:title>Fixture</dc:title><dc:language>en</dc:language></metadata>
                      <manifest>
                        <item id="chapter" href="text/chapter.xhtml" media-type="application/xhtml+xml"/>
                        <item id="appendix" href="appendix.xhtml" media-type="application/xhtml+xml"/>
                      </manifest>
                      <spine><itemref idref="chapter"/><itemref idref="appendix"/></spine>
                    </package>
                    """);
            add(zip, "OPS/text/chapter.xhtml", """
                    <?xml version="1.0" encoding="UTF-8"?>
                    <html xmlns="http://www.w3.org/1999/xhtml"><head><title>Lesson</title></head><body><p>Grounded EPUB lesson text</p></body></html>
                    """);
            add(zip, "OPS/appendix.xhtml", """
                    <?xml version="1.0" encoding="UTF-8"?>
                    <html xmlns="http://www.w3.org/1999/xhtml"><body><p>Grounded appendix text</p></body></html>
                    """);
        }
    }

    private static void add(ZipOutputStream zip, String name, String content)
            throws IOException {
        zip.putNextEntry(new ZipEntry(name));
        zip.write(content.getBytes(StandardCharsets.UTF_8));
        zip.closeEntry();
    }
}
