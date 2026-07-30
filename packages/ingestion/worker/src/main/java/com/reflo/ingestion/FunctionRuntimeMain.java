package com.reflo.ingestion;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * Function Compute custom-runtime endpoint for one SESSION_EXCLUSIVE parser
 * instance. The session ID is intentionally not read or persisted: FC owns
 * affinity, while this process fences every request by operation and input
 * hash and accepts only one monotonically advancing job.
 */
public final class FunctionRuntimeMain {
    static final String CONTRACT = "serverless-isolated-ingestion-session-v1";
    static final int MAX_CHUNK_BYTES = 8 * 1024 * 1024;
    static final int MAX_HEADER_BYTES = 16 * 1024;
    static final int MAX_FRAME_BYTES = 16 + MAX_HEADER_BYTES + MAX_CHUNK_BYTES;
    private static final long MAX_INPUT_BYTES = 50L * 1024L * 1024L;
    private static final long MAX_OUTPUT_BYTES = 512L * 1024L * 1024L;
    private static final long MAX_JOB_STORAGE_BYTES = 4L * 1024L * 1024L * 1024L;
    private static final Duration MAX_SNAPSHOT_AGE = Duration.ofHours(24);
    private static final Duration MAX_FUTURE_SKEW = Duration.ofMinutes(5);
    private static final Duration SESSION_TTL = Duration.ofHours(1);
    private static final byte[] MAGIC = "REFLOFC1".getBytes(StandardCharsets.US_ASCII);
    private static final Pattern OPAQUE_ID = Pattern.compile("[A-Za-z0-9_-]{8,128}");
    private static final Pattern SHA256 = Pattern.compile("[a-f0-9]{64}");
    private static final Pattern DIGEST = Pattern.compile("sha256:[a-f0-9]{64}");
    private static final Pattern SNAPSHOT_ID = Pattern.compile("cvd-[a-f0-9]{32}");
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Set<String> FAILURE_CODES = Set.of(
            "active_content", "archive_limit", "authorization_denied", "encrypted",
            "hash_mismatch", "infrastructure_unavailable", "invalid_output",
            "malformed_document", "malware_detected", "mime_mismatch", "page_limit",
            "parse_oom", "parse_timeout", "parser_crash", "retention_blocked",
            "scan_db_stale", "unsupported_type");

    private FunctionRuntimeMain() {}

    public static void main(String[] args) throws Exception {
        assertRuntimeBoundary();
        int port = requiredPort(System.getenv("FC_SERVER_PORT"));
        SessionEngine engine = new SessionEngine(Clock.systemUTC());
        HttpServer server = HttpServer.create(new InetSocketAddress("0.0.0.0", port), 0);
        server.createContext("/invoke", exchange -> handle(exchange, engine));
        server.setExecutor(Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "reflo-fc-session");
            thread.setDaemon(false);
            return thread;
        }));
        server.start();
    }

    private static void handle(HttpExchange exchange, SessionEngine engine) {
        byte[] response;
        try {
            if (!"POST".equals(exchange.getRequestMethod())
                    || exchange.getRequestURI().getRawQuery() != null) {
                throw new ProtocolFailure("invalid_output");
            }
            byte[] request = readBounded(exchange.getRequestBody(), MAX_FRAME_BYTES);
            response = engine.handle(Frame.decode(request)).encode();
        } catch (ProtocolFailure failure) {
            response = Frame.failure(failure.code).encode();
        } catch (OutOfMemoryError error) {
            response = Frame.failure("parse_oom").encode();
        } catch (Throwable error) {
            response = Frame.failure("infrastructure_unavailable").encode();
        }
        try {
            exchange.getResponseHeaders().set("content-type", "application/octet-stream");
            exchange.getResponseHeaders().set("cache-control", "no-store");
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
        } catch (IOException ignored) {
            // The trusted client reconciles an ambiguous invocation by operation
            // identity and never creates a second logical parse.
        } finally {
            exchange.close();
        }
    }

    static final class SessionEngine {
        private final Clock clock;
        private State state;

        SessionEngine(Clock clock) {
            this.clock = clock;
        }

        synchronized Frame handle(Frame request) throws Exception {
            String action = string(request.header, "action");
            return switch (action) {
                case "upload" -> upload(request);
                case "parse" -> parse(request);
                case "download" -> download(request);
                case "cleanup" -> cleanup(request);
                case "inspect" -> inspect(request);
                default -> throw new ProtocolFailure("invalid_output");
            };
        }

        private Frame upload(Frame request) throws Exception {
            exactKeys(request.header, Set.of(
                    "action", "chunkSha256", "contractVersion", "documentKind",
                    "inputSha256", "operationId", "processingLane", "sequence",
                    "totalBytes", "totalChunks", "workerArtifactDigest"));
            if (request.payload.length < 1 || request.payload.length > MAX_CHUNK_BYTES) {
                throw new ProtocolFailure("invalid_output");
            }
            String operationId = matching(request.header, "operationId", OPAQUE_ID);
            String inputSha256 = matching(request.header, "inputSha256", SHA256);
            String chunkSha256 = matching(request.header, "chunkSha256", SHA256);
            String artifactDigest =
                    matching(request.header, "workerArtifactDigest", DIGEST);
            String documentKind = oneOf(
                    request.header, "documentKind", Set.of("pdf", "epub", "docx"));
            String processingLane = oneOf(
                    request.header, "processingLane", Set.of("standard", "large"));
            int sequence = integer(request.header, "sequence", 0, 63);
            int totalChunks = integer(request.header, "totalChunks", 1, 64);
            long totalBytes = longInteger(
                    request.header, "totalBytes", 1, MAX_INPUT_BYTES);
            if (!sha256(request.payload).equals(chunkSha256)
                    || totalChunks != chunkCount(totalBytes)
                    || sequence >= totalChunks) {
                throw new ProtocolFailure("hash_mismatch");
            }
            if (state == null) {
                if (sequence != 0) {
                    throw new ProtocolFailure("invalid_output");
                }
                Path directory = Files.createDirectory(
                        Path.of("/tmp", "reflo-session-" + UUID.randomUUID()));
                try {
                    Files.setPosixFilePermissions(directory, Set.of(
                            PosixFilePermission.OWNER_READ,
                            PosixFilePermission.OWNER_WRITE,
                            PosixFilePermission.OWNER_EXECUTE));
                } catch (UnsupportedOperationException error) {
                    deleteRecursively(directory);
                    throw new ProtocolFailure("infrastructure_unavailable");
                }
                state = new State(
                        artifactDigest,
                        documentKind,
                        directory,
                        inputSha256,
                        operationId,
                        processingLane,
                        clock.instant(),
                        totalBytes,
                        totalChunks);
                Files.createFile(state.input);
            }
            state.assertIdentity(operationId, inputSha256);
            state.assertLive(clock.instant());
            if (state.parsed
                    || state.artifactDigest.equals(artifactDigest) == false
                    || state.documentKind.equals(documentKind) == false
                    || state.processingLane.equals(processingLane) == false
                    || state.totalBytes != totalBytes
                    || state.totalChunks != totalChunks
                    || state.nextUploadSequence != sequence) {
                throw new ProtocolFailure("invalid_output");
            }
            Files.write(state.input, request.payload, java.nio.file.StandardOpenOption.APPEND);
            state.uploadedBytes += request.payload.length;
            state.nextUploadSequence++;
            if (state.uploadedBytes > state.totalBytes
                    || directoryBytes(state.directory) > MAX_JOB_STORAGE_BYTES) {
                throw new ProtocolFailure("archive_limit");
            }
            if (state.nextUploadSequence == state.totalChunks) {
                if (state.uploadedBytes != state.totalBytes
                        || !sha256(Files.readAllBytes(state.input)).equals(state.inputSha256)) {
                    throw new ProtocolFailure("hash_mismatch");
                }
                state.uploadComplete = true;
            }
            return Frame.ack("upload", sequence);
        }

        private Frame parse(Frame request) throws Exception {
            exactKeys(request.header, Set.of(
                    "action", "contractVersion", "inputSha256", "operationId"));
            State active = requiredState(request);
            if (!request.payloadIsEmpty()
                    || !active.uploadComplete
                    || active.parsed) {
                throw new ProtocolFailure("invalid_output");
            }
            active.assertLive(clock.instant());
            verifyAndScan(active.input, clock.instant());
            runWorker(active);
            if (!Files.isRegularFile(active.output)
                    || Files.isSymbolicLink(active.output)) {
                throw new ProtocolFailure("invalid_output");
            }
            active.outputBytes = Files.size(active.output);
            if (active.outputBytes < 1 || active.outputBytes > MAX_OUTPUT_BYTES
                    || directoryBytes(active.directory) > MAX_JOB_STORAGE_BYTES) {
                throw new ProtocolFailure("invalid_output");
            }
            active.outputSha256 = sha256(Files.readAllBytes(active.output));
            active.outputChunks = chunkCount(active.outputBytes);
            active.parsed = true;
            return Frame.result(
                    active.outputBytes, active.outputSha256, active.outputChunks);
        }

        private Frame download(Frame request) throws Exception {
            exactKeys(request.header, Set.of(
                    "action", "contractVersion", "inputSha256", "operationId",
                    "sequence"));
            State active = requiredState(request);
            int sequence = integer(request.header, "sequence", 0, 63);
            boolean current = sequence == active.nextDownloadSequence;
            boolean replay = sequence + 1 == active.nextDownloadSequence;
            if (!request.payloadIsEmpty()
                    || !active.parsed
                    || (!current && !replay)
                    || sequence >= active.outputChunks) {
                throw new ProtocolFailure("invalid_output");
            }
            active.assertLive(clock.instant());
            long start = (long) sequence * MAX_CHUNK_BYTES;
            int length = (int) Math.min(
                    MAX_CHUNK_BYTES, active.outputBytes - start);
            byte[] payload = new byte[length];
            try (var channel = Files.newByteChannel(active.output)) {
                channel.position(start);
                ByteBuffer buffer = ByteBuffer.wrap(payload);
                while (buffer.hasRemaining() && channel.read(buffer) >= 0) {
                    // bounded output chunk
                }
                if (buffer.hasRemaining()) {
                    throw new ProtocolFailure("invalid_output");
                }
            }
            if (current) {
                active.nextDownloadSequence++;
            }
            return Frame.chunk(
                    active.outputBytes,
                    active.outputSha256,
                    sequence,
                    active.outputChunks,
                    payload);
        }

        private Frame cleanup(Frame request) throws Exception {
            exactKeys(request.header, Set.of(
                    "action", "contractVersion", "inputSha256", "operationId"));
            State active = requiredState(request);
            if (!request.payloadIsEmpty()) {
                throw new ProtocolFailure("invalid_output");
            }
            deleteRecursively(active.directory);
            state = null;
            return Frame.ack("cleanup", 0);
        }

        private Frame inspect(Frame request) throws Exception {
            exactKeys(request.header, Set.of(
                    "action", "contractVersion", "inputSha256", "operationId"));
            State active = requiredState(request);
            if (!request.payloadIsEmpty()) {
                throw new ProtocolFailure("invalid_output");
            }
            active.assertLive(clock.instant());
            if (active.parsed) {
                return Frame.parsedState(
                        active.nextUploadSequence,
                        active.nextDownloadSequence,
                        active.outputBytes,
                        active.outputSha256,
                        active.outputChunks);
            }
            return Frame.uploadState(
                    active.uploadComplete ? "uploaded" : "uploading",
                    active.nextUploadSequence);
        }

        private State requiredState(Frame request) throws ProtocolFailure {
            if (state == null) {
                throw new ProtocolFailure("invalid_output");
            }
            state.assertIdentity(
                    matching(request.header, "operationId", OPAQUE_ID),
                    matching(request.header, "inputSha256", SHA256));
            return state;
        }
    }

    private static final class State {
        private final String artifactDigest;
        private final String documentKind;
        private final Path directory;
        private final Path input;
        private final String inputSha256;
        private final String operationId;
        private final Path output;
        private final String processingLane;
        private final Instant startedAt;
        private final long totalBytes;
        private final int totalChunks;
        private int nextUploadSequence;
        private long uploadedBytes;
        private boolean uploadComplete;
        private boolean parsed;
        private long outputBytes;
        private String outputSha256;
        private int outputChunks;
        private int nextDownloadSequence;

        private State(
                String artifactDigest,
                String documentKind,
                Path directory,
                String inputSha256,
                String operationId,
                String processingLane,
                Instant startedAt,
                long totalBytes,
                int totalChunks) {
            this.artifactDigest = artifactDigest;
            this.documentKind = documentKind;
            this.directory = directory;
            this.input = directory.resolve("source");
            this.inputSha256 = inputSha256;
            this.operationId = operationId;
            this.output = directory.resolve("normalized-document.json");
            this.processingLane = processingLane;
            this.startedAt = startedAt;
            this.totalBytes = totalBytes;
            this.totalChunks = totalChunks;
        }

        private void assertIdentity(String operationId, String inputSha256)
                throws ProtocolFailure {
            if (!this.operationId.equals(operationId)
                    || !this.inputSha256.equals(inputSha256)) {
                throw new ProtocolFailure("authorization_denied");
            }
        }

        private void assertLive(Instant now) throws ProtocolFailure {
            Duration age = Duration.between(startedAt, now);
            if (age.isNegative() || age.compareTo(SESSION_TTL) > 0) {
                throw new ProtocolFailure("infrastructure_unavailable");
            }
        }
    }

    static final class Frame {
        private final Map<String, Object> header;
        private final byte[] payload;

        Frame(Map<String, Object> header, byte[] payload) throws ProtocolFailure {
            if (!CONTRACT.equals(header.get("contractVersion"))) {
                throw new ProtocolFailure("invalid_output");
            }
            this.header = Map.copyOf(header);
            this.payload = payload.clone();
        }

        static Frame decode(byte[] bytes) throws ProtocolFailure {
            if (bytes.length < 16 || bytes.length > MAX_FRAME_BYTES) {
                throw new ProtocolFailure("invalid_output");
            }
            ByteBuffer prefix = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN);
            byte[] magic = new byte[MAGIC.length];
            prefix.get(magic);
            if (!MessageDigest.isEqual(magic, MAGIC)) {
                throw new ProtocolFailure("invalid_output");
            }
            int headerLength = prefix.getInt();
            int payloadLength = prefix.getInt();
            if (headerLength < 2
                    || headerLength > MAX_HEADER_BYTES
                    || payloadLength < 0
                    || payloadLength > MAX_CHUNK_BYTES
                    || 16 + headerLength + payloadLength != bytes.length) {
                throw new ProtocolFailure("invalid_output");
            }
            try {
                Map<String, Object> header = JSON.readValue(
                        bytes,
                        16,
                        headerLength,
                        new TypeReference<Map<String, Object>>() {});
                byte[] payload = java.util.Arrays.copyOfRange(
                        bytes, 16 + headerLength, bytes.length);
                return new Frame(header, payload);
            } catch (IOException | RuntimeException error) {
                throw new ProtocolFailure("invalid_output");
            }
        }

        byte[] encode() {
            try {
                byte[] headerBytes = JSON.writeValueAsBytes(header);
                if (headerBytes.length > MAX_HEADER_BYTES
                        || payload.length > MAX_CHUNK_BYTES) {
                    throw new IllegalStateException("frame exceeds protocol");
                }
                ByteBuffer result = ByteBuffer.allocate(
                                16 + headerBytes.length + payload.length)
                        .order(ByteOrder.BIG_ENDIAN);
                result.put(MAGIC);
                result.putInt(headerBytes.length);
                result.putInt(payload.length);
                result.put(headerBytes);
                result.put(payload);
                return result.array();
            } catch (IOException error) {
                throw new IllegalStateException("frame serialization failed", error);
            }
        }

        boolean payloadIsEmpty() {
            return payload.length == 0;
        }

        static Frame ack(String phase, int sequence) throws ProtocolFailure {
            return response(Map.of(
                    "action", "ack",
                    "phase", phase,
                    "sequence", sequence));
        }

        static Frame result(long bytes, String hash, int chunks)
                throws ProtocolFailure {
            return response(Map.of(
                    "action", "result",
                    "outputBytes", bytes,
                    "outputSha256", hash,
                    "totalChunks", chunks));
        }

        static Frame chunk(
                long bytes, String hash, int sequence, int chunks, byte[] payload)
                throws ProtocolFailure {
            Map<String, Object> header = new LinkedHashMap<>();
            header.put("action", "chunk");
            header.put("chunkSha256", sha256(payload));
            header.put("contractVersion", CONTRACT);
            header.put("outputBytes", bytes);
            header.put("outputSha256", hash);
            header.put("sequence", sequence);
            header.put("totalChunks", chunks);
            return new Frame(header, payload);
        }

        static Frame failure(String code) {
            try {
                return response(Map.of(
                        "action", "failure",
                        "code", FAILURE_CODES.contains(code)
                                ? code
                                : "infrastructure_unavailable"));
            } catch (ProtocolFailure impossible) {
                throw new IllegalStateException(impossible);
            }
        }

        static Frame uploadState(String phase, int nextUploadSequence)
                throws ProtocolFailure {
            return response(Map.of(
                    "action", "state",
                    "nextUploadSequence", nextUploadSequence,
                    "phase", phase));
        }

        static Frame parsedState(
                int nextUploadSequence,
                int nextDownloadSequence,
                long outputBytes,
                String outputSha256,
                int totalChunks) throws ProtocolFailure {
            return response(Map.of(
                    "action", "state",
                    "nextDownloadSequence", nextDownloadSequence,
                    "nextUploadSequence", nextUploadSequence,
                    "outputBytes", outputBytes,
                    "outputSha256", outputSha256,
                    "phase", "parsed",
                    "totalChunks", totalChunks));
        }

        private static Frame response(Map<String, Object> values)
                throws ProtocolFailure {
            Map<String, Object> header = new LinkedHashMap<>(values);
            header.put("contractVersion", CONTRACT);
            return new Frame(header, new byte[0]);
        }
    }

    private static void verifyAndScan(Path input, Instant now) throws Exception {
        Path root = Path.of("/opt/reflo/clamav");
        List<Path> snapshots;
        try (var directories = Files.list(root)) {
            snapshots = directories
                    .filter(Files::isDirectory)
                    .filter(path -> SNAPSHOT_ID.matcher(path.getFileName().toString()).matches())
                    .toList();
        } catch (IOException error) {
            throw new ProtocolFailure("scan_db_stale");
        }
        if (snapshots.size() != 1) {
            throw new ProtocolFailure("scan_db_stale");
        }
        Path snapshot = snapshots.get(0);
        Path manifestPath = snapshot.resolve("snapshot.json");
        Map<String, Object> manifest;
        try {
            byte[] bytes = readRegularFile(manifestPath, 256 * 1024);
            manifest = JSON.readValue(bytes, new TypeReference<Map<String, Object>>() {});
        } catch (IOException | RuntimeException error) {
            throw new ProtocolFailure("scan_db_stale");
        }
        exactKeys(manifest, Set.of(
                "clamAvVersion", "contractVersion", "files", "profile",
                "publishedAt", "snapshotId", "toolchain"));
        if (!"1.4.5".equals(manifest.get("clamAvVersion"))
                || !"upstream-clamav-snapshot-manifest-v1".equals(
                        manifest.get("contractVersion"))
                || !"upstream-clamav-cloud-demo-v1".equals(manifest.get("profile"))
                || !snapshot.getFileName().toString().equals(manifest.get("snapshotId"))) {
            throw new ProtocolFailure("scan_db_stale");
        }
        Instant publishedAt = instant(manifest.get("publishedAt"));
        assertFresh(publishedAt, now);
        Map<String, Object> toolchain = record(manifest.get("toolchain"));
        exactKeys(toolchain, Set.of("freshClamImageDigest", "sigtoolVersion"));
        matching(toolchain, "freshClamImageDigest", DIGEST);
        String expectedSigtool = string(toolchain, "sigtoolVersion");
        List<Map<String, Object>> files = records(manifest.get("files"));
        if (files.size() != 3) {
            throw new ProtocolFailure("scan_db_stale");
        }
        Set<String> expectedNames = Set.of("main.cvd");
        List<String> names = new ArrayList<>();
        for (Map<String, Object> file : files) {
            exactKeys(file, Set.of(
                    "buildTime", "byteLength", "databaseVersion", "name", "sha256"));
            String name = string(file, "name");
            if (!name.matches("(?:main\\.cvd|daily\\.(?:cld|cvd)|bytecode\\.(?:cld|cvd))")
                    || names.contains(name)) {
                throw new ProtocolFailure("scan_db_stale");
            }
            Path database = snapshot.resolve(name).normalize();
            if (!database.getParent().equals(snapshot)
                    || Files.size(database) != longInteger(
                            file, "byteLength", 1, 512L * 1024L * 1024L)
                    || !sha256(readRegularFile(database, 512 * 1024 * 1024))
                            .equals(matching(file, "sha256", SHA256))
                    || longInteger(file, "databaseVersion", 1, Integer.MAX_VALUE) < 1) {
                throw new ProtocolFailure("scan_db_stale");
            }
            if (name.startsWith("daily.")) {
                assertFresh(instant(file.get("buildTime")), now);
            }
            names.add(name);
        }
        if (!names.containsAll(expectedNames)
                || names.stream().filter(name -> name.startsWith("daily.")).count() != 1
                || names.stream().filter(name -> name.startsWith("bytecode.")).count() != 1) {
            throw new ProtocolFailure("scan_db_stale");
        }
        ProcessResult sigtoolVersion = runProcess(
                List.of("/opt/reflo/native/bin/sigtool", "--version"),
                Duration.ofSeconds(5));
        if (sigtoolVersion.exitCode != 0
                || !expectedSigtool.equals(sigtoolVersion.output.strip())
                || !expectedSigtool.startsWith("ClamAV 1.4.5")) {
            throw new ProtocolFailure("scan_db_stale");
        }
        for (String name : names) {
            ProcessResult verified = runProcess(
                    List.of(
                            "/opt/reflo/native/bin/sigtool",
                            "--info",
                            snapshot.resolve(name).toString()),
                    Duration.ofSeconds(60));
            if (verified.exitCode != 0
                    || !verified.output.contains("Verification OK.")) {
                throw new ProtocolFailure("scan_db_stale");
            }
        }
        ProcessResult version = runProcess(
                List.of("/opt/reflo/native/bin/clamscan", "--version"),
                Duration.ofSeconds(5));
        if (version.exitCode != 0
                || !version.output.startsWith("ClamAV 1.4.5")) {
            throw new ProtocolFailure("infrastructure_unavailable");
        }
        ProcessResult scan = runProcess(
                List.of(
                        "/opt/reflo/native/bin/clamscan",
                        "--database=" + snapshot,
                        "--no-summary",
                        "--stdout",
                        "--infected",
                        "--",
                        input.toString()),
                Duration.ofMinutes(10));
        if (scan.exitCode == 1) {
            throw new ProtocolFailure("malware_detected");
        }
        if (scan.exitCode != 0) {
            throw new ProtocolFailure("infrastructure_unavailable");
        }
    }

    private static void runWorker(State state) throws Exception {
        ProcessBuilder builder = new ProcessBuilder(
                "/opt/java/openjdk/bin/java",
                "-Djava.awt.headless=true",
                "-Djava.io.tmpdir=" + state.directory,
                "-cp",
                "/opt/reflo/worker.jar",
                "com.reflo.ingestion.WorkerMain");
        Map<String, String> environment = builder.environment();
        environment.clear();
        environment.put("HOME", state.directory.toString());
        environment.put("LANG", "C.UTF-8");
        environment.put("LD_LIBRARY_PATH", "/opt/reflo/native/lib");
        environment.put("PATH", "/opt/java/openjdk/bin:/opt/reflo/native/bin:/usr/bin:/bin");
        environment.put("REFLO_CLAMAV_VERSION", "1.4.5");
        environment.put("REFLO_DOCUMENT_KIND", state.documentKind);
        environment.put("REFLO_INGESTION_PROFILE", "isolated-ingestion-v1");
        environment.put("REFLO_INPUT_PATH", state.input.toString());
        environment.put("REFLO_INPUT_SHA256", state.inputSha256);
        environment.put("REFLO_OCR_LANGUAGE_PROFILE", "eng-tessdata_fast-checksum-pinned");
        environment.put("REFLO_OUTPUT_PATH", state.output.toString());
        environment.put("REFLO_RUNTIME_PROFILE", "function-session-v1");
        environment.put("REFLO_TESSERACT_VERSION", "tesseract-5.5.2");
        environment.put("REFLO_TIKA_VERSION", "apache-tika-3.3.1");
        environment.put("REFLO_WORKER_IMAGE_DIGEST", state.artifactDigest);
        builder.redirectOutput(ProcessBuilder.Redirect.DISCARD);
        Path diagnostics = state.directory.resolve("worker.stderr");
        builder.redirectError(diagnostics.toFile());
        Process process;
        try {
            process = builder.start();
        } catch (IOException error) {
            throw new ProtocolFailure("infrastructure_unavailable");
        }
        Duration timeout = "standard".equals(state.processingLane)
                ? Duration.ofSeconds(90)
                : Duration.ofMinutes(29);
        boolean completed = process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS);
        if (!completed) {
            process.destroy();
            if (!process.waitFor(2, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                process.waitFor(2, TimeUnit.SECONDS);
            }
            throw new ProtocolFailure("parse_timeout");
        }
        int exitCode = process.exitValue();
        if (exitCode == 0) {
            Files.deleteIfExists(diagnostics);
            return;
        }
        String output = "";
        try {
            output = new String(readRegularFile(diagnostics, 2_048), StandardCharsets.UTF_8);
        } catch (Exception ignored) {
            // A bounded missing diagnostic maps to parser_crash.
        }
        String code = output.lines()
                .filter(line -> line.matches("REFLO_FAILURE:[a-z_]+"))
                .map(line -> line.substring("REFLO_FAILURE:".length()))
                .findFirst()
                .orElse("parser_crash");
        Files.deleteIfExists(diagnostics);
        throw new ProtocolFailure(FAILURE_CODES.contains(code) ? code : "parser_crash");
    }

    private static ProcessResult runProcess(List<String> command, Duration timeout)
            throws Exception {
        Path output = Files.createTempFile(
                Path.of("/tmp"), "reflo-tool-", ".log");
        try {
            ProcessBuilder builder = new ProcessBuilder(command);
            Map<String, String> environment = builder.environment();
            environment.clear();
            environment.put("HOME", "/tmp");
            environment.put("LANG", "C.UTF-8");
            environment.put("LD_LIBRARY_PATH", "/opt/reflo/native/lib");
            environment.put("PATH", "/opt/reflo/native/bin:/usr/bin:/bin");
            builder.redirectErrorStream(true);
            builder.redirectOutput(output.toFile());
            Process process = builder.start();
            if (!process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS)) {
                process.destroyForcibly();
                process.waitFor(2, TimeUnit.SECONDS);
                return new ProcessResult(124, "");
            }
            byte[] bytes;
            try {
                bytes = readRegularFile(output, 8 * 1024);
            } catch (ProtocolFailure error) {
                bytes = new byte[0];
            }
            return new ProcessResult(
                    process.exitValue(),
                    new String(bytes, StandardCharsets.UTF_8));
        } finally {
            Files.deleteIfExists(output);
        }
    }

    private static void assertRuntimeBoundary() throws ProtocolFailure {
        String user = ProcessHandle.current().info().user().orElse("");
        if (user.isBlank() || "root".equals(user)
                || !Files.isDirectory(Path.of("/code"))
                || !Files.isDirectory(Path.of("/opt"))
                || Files.isWritable(Path.of("/code"))
                || Files.isWritable(Path.of("/opt"))) {
            throw new ProtocolFailure("infrastructure_unavailable");
        }
    }

    private static int requiredPort(String value) throws ProtocolFailure {
        try {
            int port = Integer.parseInt(value);
            if (port < 1 || port > 65_535) {
                throw new NumberFormatException();
            }
            return port;
        } catch (RuntimeException error) {
            throw new ProtocolFailure("infrastructure_unavailable");
        }
    }

    private static int chunkCount(long bytes) throws ProtocolFailure {
        if (bytes < 1 || bytes > MAX_OUTPUT_BYTES) {
            throw new ProtocolFailure("invalid_output");
        }
        return (int) ((bytes + MAX_CHUNK_BYTES - 1) / MAX_CHUNK_BYTES);
    }

    private static byte[] readBounded(InputStream stream, int maximum)
            throws IOException, ProtocolFailure {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[64 * 1024];
        int read;
        while ((read = stream.read(buffer)) >= 0) {
            if (output.size() + read > maximum) {
                throw new ProtocolFailure("invalid_output");
            }
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private static byte[] readRegularFile(Path path, int maximum)
            throws IOException, ProtocolFailure {
        if (!Files.isRegularFile(path)
                || Files.isSymbolicLink(path)
                || Files.size(path) < 1
                || Files.size(path) > maximum) {
            throw new ProtocolFailure("scan_db_stale");
        }
        byte[] bytes = Files.readAllBytes(path);
        if (bytes.length > maximum) {
            throw new ProtocolFailure("scan_db_stale");
        }
        return bytes;
    }

    private static long directoryBytes(Path root) throws IOException {
        final long[] total = {0};
        Files.walkFileTree(root, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attributes)
                    throws IOException {
                if (attributes.isSymbolicLink()) {
                    throw new IOException("session symlink rejected");
                }
                total[0] = Math.addExact(total[0], attributes.size());
                return FileVisitResult.CONTINUE;
            }
        });
        return total[0];
    }

    private static void deleteRecursively(Path root) throws IOException {
        if (!Path.of("/tmp").equals(root.getParent())
                || !root.getFileName().toString().startsWith("reflo-session-")) {
            throw new IOException("unsafe cleanup root");
        }
        if (!Files.exists(root)) {
            return;
        }
        Files.walkFileTree(root, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attributes)
                    throws IOException {
                Files.delete(file);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path directory, IOException error)
                    throws IOException {
                if (error != null) {
                    throw error;
                }
                Files.delete(directory);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception error) {
            throw new IllegalStateException("SHA-256 unavailable", error);
        }
    }

    private static String string(Map<String, Object> map, String name)
            throws ProtocolFailure {
        Object value = map.get(name);
        if (!(value instanceof String text) || text.isBlank()) {
            throw new ProtocolFailure("invalid_output");
        }
        return text;
    }

    private static String matching(
            Map<String, Object> map, String name, Pattern pattern)
            throws ProtocolFailure {
        String value = string(map, name);
        if (!pattern.matcher(value).matches()) {
            throw new ProtocolFailure("invalid_output");
        }
        return value;
    }

    private static String oneOf(
            Map<String, Object> map, String name, Set<String> allowed)
            throws ProtocolFailure {
        String value = string(map, name);
        if (!allowed.contains(value)) {
            throw new ProtocolFailure("invalid_output");
        }
        return value;
    }

    private static int integer(
            Map<String, Object> map, String name, int minimum, int maximum)
            throws ProtocolFailure {
        long value = longInteger(map, name, minimum, maximum);
        return (int) value;
    }

    private static long longInteger(
            Map<String, Object> map, String name, long minimum, long maximum)
            throws ProtocolFailure {
        Object raw = map.get(name);
        if (!(raw instanceof Number number)) {
            throw new ProtocolFailure("invalid_output");
        }
        long value = number.longValue();
        if (number.doubleValue() != value || value < minimum || value > maximum) {
            throw new ProtocolFailure("invalid_output");
        }
        return value;
    }

    private static Map<String, Object> record(Object value)
            throws ProtocolFailure {
        if (!(value instanceof Map<?, ?> raw)) {
            throw new ProtocolFailure("scan_db_stale");
        }
        Map<String, Object> result = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : raw.entrySet()) {
            if (!(entry.getKey() instanceof String key)) {
                throw new ProtocolFailure("scan_db_stale");
            }
            result.put(key, entry.getValue());
        }
        return result;
    }

    private static List<Map<String, Object>> records(Object value)
            throws ProtocolFailure {
        if (!(value instanceof List<?> list)) {
            throw new ProtocolFailure("scan_db_stale");
        }
        List<Map<String, Object>> result = new ArrayList<>();
        for (Object item : list) {
            result.add(record(item));
        }
        return result;
    }

    private static void exactKeys(Map<String, Object> value, Set<String> expected)
            throws ProtocolFailure {
        if (!value.keySet().equals(expected)) {
            throw new ProtocolFailure("invalid_output");
        }
    }

    private static Instant instant(Object value) throws ProtocolFailure {
        try {
            return Instant.parse((String) value);
        } catch (RuntimeException error) {
            throw new ProtocolFailure("scan_db_stale");
        }
    }

    private static void assertFresh(Instant value, Instant now)
            throws ProtocolFailure {
        Duration age = Duration.between(value, now);
        if (age.compareTo(MAX_SNAPSHOT_AGE) > 0
                || age.compareTo(MAX_FUTURE_SKEW.negated()) < 0) {
            throw new ProtocolFailure("scan_db_stale");
        }
    }

    private record ProcessResult(int exitCode, String output) {}

    static final class ProtocolFailure extends Exception {
        private final String code;

        ProtocolFailure(String code) {
            super(code);
            this.code = FAILURE_CODES.contains(code)
                    ? code
                    : "infrastructure_unavailable";
        }
    }
}
