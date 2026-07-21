package com.reflo.ingestion;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.rendering.ImageType;
import org.apache.pdfbox.rendering.PDFRenderer;
import org.apache.pdfbox.text.PDFTextStripper;
import org.apache.tika.exception.EncryptedDocumentException;
import org.apache.tika.extractor.EmbeddedDocumentExtractor;
import org.apache.tika.metadata.Metadata;
import org.apache.tika.parser.ParseContext;
import org.apache.tika.parser.Parser;
import org.apache.tika.parser.epub.EpubParser;
import org.apache.tika.parser.microsoft.ooxml.OOXMLParser;
import org.apache.tika.parser.pdf.PDFParser;
import org.apache.tika.parser.pdf.PDFParserConfig;
import org.apache.tika.sax.BodyContentHandler;
import org.xml.sax.ContentHandler;
import org.xml.sax.SAXException;
import org.xml.sax.helpers.DefaultHandler;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

public final class WorkerMain {
    private static final String CONTRACT_VERSION = "normalized-document-v1";
    private static final String PROFILE_VERSION = "isolated-ingestion-v1";
    private static final String CLASSIFIER_VERSION = "scan-detect-v1";
    private static final String PARSER_VERSION = "apache-tika-3.3.1";
    private static final Pattern PARAGRAPH_BREAK = Pattern.compile("(?:\\R[\\t ]*){2,}");
    private static final Set<String> DOCUMENT_KINDS = Set.of("pdf", "epub", "docx");
    private static final int MAX_STABLE_PAGES = 800;
    private static final int RASTER_DPI = 300;
    private static final int TEXT_CHARACTER_THRESHOLD = 50;
    private static final double CONTENT_COVERAGE_THRESHOLD = 0.05d;
    private static final ObjectMapper JSON = new ObjectMapper()
            .disable(SerializationFeature.FAIL_ON_EMPTY_BEANS);

    private WorkerMain() {}

    public static void main(String[] args) {
        System.setProperty("java.awt.headless", "true");
        try {
            run();
        } catch (WorkerFailure failure) {
            System.err.println("REFLO_FAILURE:" + failure.code);
            System.exit(42);
        } catch (OutOfMemoryError error) {
            System.err.println("REFLO_FAILURE:parse_oom");
            System.exit(42);
        } catch (Throwable error) {
            System.err.println("REFLO_FAILURE:parser_crash");
            System.exit(42);
        }
    }

    private static void run() throws Exception {
        Environment environment = Environment.read();
        Path input = Path.of("/work/input/source");
        Path output = Path.of("/work/output/normalized-document.json");
        if (!Files.isRegularFile(input) || Files.isSymbolicLink(input)) {
            throw new WorkerFailure("malformed_document");
        }
        String actualHash = sha256(Files.readAllBytes(input));
        if (!MessageDigest.isEqual(
                actualHash.getBytes(StandardCharsets.US_ASCII),
                environment.inputSha256.getBytes(StandardCharsets.US_ASCII))) {
            throw new WorkerFailure("malformed_document");
        }

        Parsed parsed = switch (environment.documentKind) {
            case "pdf" -> parsePdf(input);
            case "epub" -> parseEpub(input);
            case "docx" -> parseDocx(input);
            default -> throw new WorkerFailure("unsupported_type");
        };
        NormalizedDocument document = new NormalizedDocument(
                parsed.blocks,
                CLASSIFIER_VERSION,
                PROFILE_VERSION,
                CONTRACT_VERSION,
                parsed.diagnostics,
                environment.documentKind,
                environment.inputSha256,
                parsed.pageCount,
                PARSER_VERSION,
                parsed.scan,
                environment.workerImageDigest);
        byte[] serialized = JSON.writeValueAsBytes(document);
        if (serialized.length > 512L * 1024L * 1024L) {
            throw new WorkerFailure("invalid_output");
        }
        Files.write(output, serialized);
    }

    static Parsed parsePdf(Path input) throws Exception {
        PDFParserConfig configuration = new PDFParserConfig();
        configuration.setOcrStrategy(PDFParserConfig.OCR_STRATEGY.NO_OCR);
        configuration.setExtractActions(false);
        configuration.setExtractAnnotationText(false);
        configuration.setExtractInlineImages(false);
        configuration.setExtractMarkedContent(false);
        ParseContext context = restrictedContext(configuration);
        parseWithTika(input, new PDFParser(), new DefaultHandler(), context);

        try (PDDocument pdf = Loader.loadPDF(input.toFile())) {
            int pageCount = pdf.getNumberOfPages();
            if (pageCount < 1 || pageCount > MAX_STABLE_PAGES) {
                throw new WorkerFailure("page_limit");
            }
            PDFTextStripper textStripper = new PDFTextStripper();
            PDFRenderer renderer = new PDFRenderer(pdf);
            List<Block> blocks = new ArrayList<>();
            List<Integer> candidatePages = new ArrayList<>();
            int canonicalOffset = 0;
            for (int pageIndex = 0; pageIndex < pageCount; pageIndex++) {
                int pageNumber = pageIndex + 1;
                textStripper.setStartPage(pageNumber);
                textStripper.setEndPage(pageNumber);
                String pageText = textStripper.getText(pdf);
                if (normalizedCharacterCount(pageText) < TEXT_CHARACTER_THRESHOLD
                        && hasRenderedContent(renderer, pageIndex)) {
                    candidatePages.add(pageNumber);
                }
                List<String> paragraphs = paragraphs(pageText);
                for (String paragraph : paragraphs) {
                    Map<String, Object> locator = new LinkedHashMap<>();
                    locator.put("kind", "pdf");
                    locator.put("page", pageNumber);
                    locator.put("sectionPath", List.of());
                    blocks.add(block(blocks.size(), canonicalOffset, paragraph, locator));
                    canonicalOffset += paragraph.length() + 2;
                }
            }
            return new Parsed(
                    blocks,
                    List.of(),
                    pageCount,
                    scan(candidatePages, pageCount));
        } catch (org.apache.pdfbox.pdmodel.encryption.InvalidPasswordException error) {
            throw new WorkerFailure("encrypted");
        }
    }

    static Parsed parseDocx(Path input) throws Exception {
        BodyContentHandler handler = new BodyContentHandler(-1);
        parseWithTika(input, new OOXMLParser(), handler, restrictedContext(null));
        List<Block> blocks = new ArrayList<>();
        int canonicalOffset = 0;
        for (String paragraph : paragraphs(handler.toString())) {
            Map<String, Object> locator = new LinkedHashMap<>();
            locator.put("bodyElement", blocks.size());
            locator.put("headingPath", List.of());
            locator.put("kind", "docx");
            locator.put("page", null);
            locator.put("section", 0);
            blocks.add(block(blocks.size(), canonicalOffset, paragraph, locator));
            canonicalOffset += paragraph.length() + 2;
        }
        return new Parsed(
                blocks,
                List.of(),
                null,
                new Scan(List.of(), "digital", RASTER_DPI));
    }

    static Parsed parseEpub(Path input) throws Exception {
        parseWithTika(
                input,
                new EpubParser(),
                new BodyContentHandler(-1),
                restrictedContext(null));
        List<Block> blocks = new ArrayList<>();
        int canonicalOffset = 0;
        try (ZipFile archive = new ZipFile(input.toFile(), StandardCharsets.UTF_8)) {
            Document container = parseXml(requiredEntry(archive, "META-INF/container.xml"));
            NodeList rootfiles = container.getElementsByTagNameNS("*", "rootfile");
            if (rootfiles.getLength() != 1) {
                throw new WorkerFailure("malformed_document");
            }
            String packagePath = safeResourcePath(
                    null,
                    ((Element) rootfiles.item(0)).getAttribute("full-path"));
            Document packageDocument = parseXml(requiredEntry(archive, packagePath));
            Map<String, String> manifest = new LinkedHashMap<>();
            NodeList items = packageDocument.getElementsByTagNameNS("*", "item");
            for (int index = 0; index < items.getLength(); index++) {
                Element item = (Element) items.item(index);
                String id = item.getAttribute("id");
                String mediaType = item.getAttribute("media-type");
                if (!id.isBlank() && "application/xhtml+xml".equals(mediaType)) {
                    if (manifest.put(id, item.getAttribute("href")) != null) {
                        throw new WorkerFailure("malformed_document");
                    }
                }
            }
            NodeList spineItems = packageDocument.getElementsByTagNameNS("*", "itemref");
            if (spineItems.getLength() < 1 || spineItems.getLength() > 10_000) {
                throw new WorkerFailure("malformed_document");
            }
            for (int spineIndex = 0; spineIndex < spineItems.getLength(); spineIndex++) {
                Element item = (Element) spineItems.item(spineIndex);
                String href = manifest.get(item.getAttribute("idref"));
                if (href == null) {
                    throw new WorkerFailure("malformed_document");
                }
                String resource = safeResourcePath(packagePath, href);
                Document content = parseXml(requiredEntry(archive, resource));
                String text = extractDocumentText(content);
                for (String paragraph : paragraphs(text)) {
                    Map<String, Object> locator = new LinkedHashMap<>();
                    locator.put("kind", "epub");
                    locator.put("page", null);
                    locator.put("resource", resource);
                    locator.put("sectionPath", List.of());
                    locator.put("spineItem", spineIndex);
                    blocks.add(block(blocks.size(), canonicalOffset, paragraph, locator));
                    canonicalOffset += paragraph.length() + 2;
                }
            }
        } catch (WorkerFailure error) {
            throw error;
        } catch (IOException | SAXException error) {
            throw new WorkerFailure("malformed_document");
        }
        return new Parsed(
                blocks,
                List.of(),
                null,
                new Scan(List.of(), "digital", RASTER_DPI));
    }

    private static InputStream requiredEntry(ZipFile archive, String name)
            throws IOException, WorkerFailure {
        ZipEntry entry = archive.getEntry(name);
        if (entry == null || entry.isDirectory() || entry.getSize() > 100L * 1024L * 1024L) {
            throw new WorkerFailure("malformed_document");
        }
        return archive.getInputStream(entry);
    }

    private static Document parseXml(InputStream stream)
            throws Exception {
        try (stream) {
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setNamespaceAware(true);
            factory.setXIncludeAware(false);
            factory.setExpandEntityReferences(false);
            factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
            factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
            factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
            factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
            return factory.newDocumentBuilder().parse(stream);
        }
    }

    private static String safeResourcePath(String packagePath, String href)
            throws WorkerFailure {
        String withoutFragment = href.split("#", 2)[0];
        if (withoutFragment.isBlank()
                || withoutFragment.contains("?")
                || withoutFragment.contains("\\")
                || withoutFragment.startsWith("/")
                || withoutFragment.matches("^[A-Za-z][A-Za-z0-9+.-]*:.*")) {
            throw new WorkerFailure("malformed_document");
        }
        Path base = packagePath == null
                ? Path.of("")
                : Path.of(packagePath).getParent();
        Path resolved = (base == null ? Path.of("") : base)
                .resolve(withoutFragment)
                .normalize();
        String resource = resolved.toString().replace('\\', '/');
        if (resource.isBlank()
                || resource.equals("..")
                || resource.startsWith("../")
                || resource.contains("/../")) {
            throw new WorkerFailure("malformed_document");
        }
        return resource;
    }

    private static String extractDocumentText(Document document) {
        StringBuilder text = new StringBuilder();
        appendText(document.getDocumentElement(), text);
        return text.toString();
    }

    private static void appendText(Node node, StringBuilder output) {
        if (node.getNodeType() == Node.TEXT_NODE) {
            output.append(node.getNodeValue());
            return;
        }
        NodeList children = node.getChildNodes();
        for (int index = 0; index < children.getLength(); index++) {
            appendText(children.item(index), output);
        }
        String name = node.getLocalName();
        if (name != null && Set.of(
                "address", "article", "aside", "blockquote", "div", "figcaption",
                "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header",
                "li", "main", "nav", "p", "pre", "section", "table", "tr")
                .contains(name.toLowerCase())) {
            output.append("\n\n");
        }
    }

    private static void parseWithTika(
            Path input,
            Parser parser,
            ContentHandler handler,
            ParseContext context) throws Exception {
        try (InputStream stream = Files.newInputStream(input)) {
            parser.parse(stream, handler, new Metadata(), context);
        } catch (EncryptedDocumentException error) {
            throw new WorkerFailure("encrypted");
        } catch (SAXException | IOException error) {
            throw new WorkerFailure("malformed_document");
        }
    }

    private static ParseContext restrictedContext(PDFParserConfig pdfConfiguration) {
        ParseContext context = new ParseContext();
        if (pdfConfiguration != null) {
            context.set(PDFParserConfig.class, pdfConfiguration);
        }
        context.set(EmbeddedDocumentExtractor.class, new EmbeddedDocumentExtractor() {
            @Override
            public boolean shouldParseEmbedded(Metadata metadata) {
                return false;
            }

            @Override
            public void parseEmbedded(
                    InputStream stream,
                    ContentHandler handler,
                    Metadata metadata,
                    boolean outputHtml) {
                throw new SecurityException("embedded content is disabled");
            }
        });
        return context;
    }

    private static boolean hasRenderedContent(PDFRenderer renderer, int pageIndex)
            throws IOException {
        BufferedImage image = renderer.renderImageWithDPI(pageIndex, RASTER_DPI, ImageType.GRAY);
        long contentPixels = 0;
        long totalPixels = (long) image.getWidth() * image.getHeight();
        long threshold = (long) Math.ceil(totalPixels * CONTENT_COVERAGE_THRESHOLD);
        for (int y = 0; y < image.getHeight(); y++) {
            for (int x = 0; x < image.getWidth(); x++) {
                if ((image.getRGB(x, y) & 0xff) < 245 && ++contentPixels >= threshold) {
                    image.flush();
                    return true;
                }
            }
        }
        image.flush();
        return false;
    }

    private static int normalizedCharacterCount(String text) {
        int count = 0;
        for (int index = 0; index < text.length(); index++) {
            if (!Character.isWhitespace(text.charAt(index))) {
                count++;
            }
        }
        return count;
    }

    private static List<String> paragraphs(String text) {
        List<String> result = new ArrayList<>();
        for (String candidate : PARAGRAPH_BREAK.split(text)) {
            String paragraph = candidate.strip();
            if (!paragraph.isEmpty()) {
                result.add(paragraph);
            }
        }
        return result;
    }

    private static Block block(
            int order,
            int canonicalStart,
            String text,
            Map<String, Object> locator) throws WorkerFailure {
        return new Block(
                canonicalStart + text.length(),
                canonicalStart,
                "paragraph",
                locator,
                order,
                text,
                sha256(text.getBytes(StandardCharsets.UTF_8)));
    }

    private static Scan scan(List<Integer> candidatePages, int pageCount) {
        double ratio = candidatePages.size() / (double) pageCount;
        String classification = candidatePages.isEmpty()
                ? "digital"
                : ratio >= 0.8d ? "scanned" : "mixed";
        return new Scan(List.copyOf(candidatePages), classification, RASTER_DPI);
    }

    private static String sha256(byte[] bytes) throws WorkerFailure {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException error) {
            throw new WorkerFailure("parser_crash");
        }
    }

    private record Environment(
            String documentKind,
            String inputSha256,
            String workerImageDigest) {
        private static Environment read() throws WorkerFailure {
            require("REFLO_INGESTION_PROFILE", PROFILE_VERSION);
            require("REFLO_TIKA_VERSION", PARSER_VERSION);
            require("REFLO_TESSERACT_VERSION", "tesseract-5.5.2");
            require("REFLO_CLAMAV_VERSION", "1.4.5");
            require("REFLO_OCR_LANGUAGE_PROFILE", "eng-tessdata_fast-checksum-pinned");
            String kind = required("REFLO_DOCUMENT_KIND");
            String inputHash = required("REFLO_INPUT_SHA256");
            String imageDigest = required("REFLO_WORKER_IMAGE_DIGEST");
            if (!DOCUMENT_KINDS.contains(kind)
                    || !inputHash.matches("[a-f0-9]{64}")
                    || !imageDigest.matches("sha256:[a-f0-9]{64}")) {
                throw new WorkerFailure("invalid_output");
            }
            return new Environment(kind, inputHash, imageDigest);
        }

        private static String required(String name) throws WorkerFailure {
            String value = System.getenv(name);
            if (value == null || value.isBlank()) {
                throw new WorkerFailure("invalid_output");
            }
            return value;
        }

        private static void require(String name, String expected) throws WorkerFailure {
            if (!expected.equals(required(name))) {
                throw new WorkerFailure("invalid_output");
            }
        }
    }

    record Block(
            int canonicalEnd,
            int canonicalStart,
            String kind,
            Map<String, Object> locator,
            int order,
            String text,
            String textSha256) {}

    private record NormalizedDocument(
            List<Block> blocks,
            String classifierVersion,
            String configVersion,
            String contractVersion,
            List<String> diagnostics,
            String documentKind,
            String inputSha256,
            Integer pageCount,
            String parserVersion,
            Scan scan,
            String workerImageDigest) {}

    record Parsed(
            List<Block> blocks,
            List<String> diagnostics,
            Integer pageCount,
            Scan scan) {}

    record Scan(
            List<Integer> candidatePages,
            String classification,
            int rasterDpi) {}

    private static final class WorkerFailure extends Exception {
        private final String code;

        private WorkerFailure(String code) {
            super(code);
            this.code = code;
        }
    }
}
