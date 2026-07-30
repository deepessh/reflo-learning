package com.reflo.ingestion;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

final class FunctionRuntimeMainTest {
    private static final Clock CLOCK = Clock.fixed(
            Instant.parse("2026-07-28T12:00:00Z"), ZoneOffset.UTC);

    @Test
    void acceptsOneUploadSequenceAndRejectsItsReplay() throws Exception {
        byte[] payload = "trusted-pdf".getBytes(StandardCharsets.UTF_8);
        FunctionRuntimeMain.SessionEngine engine =
                new FunctionRuntimeMain.SessionEngine(CLOCK);
        FunctionRuntimeMain.Frame upload = upload(payload, "operation_123");

        byte[] response = engine.handle(upload).encode();
        assertTrue(new String(response, StandardCharsets.UTF_8).contains("\"phase\":\"upload\""));
        FunctionRuntimeMain.ProtocolFailure replay = assertThrows(
                FunctionRuntimeMain.ProtocolFailure.class,
                () -> engine.handle(upload));
        assertEquals("invalid_output", replay.getMessage());

        byte[] cleanup = engine.handle(request("cleanup", "operation_123", sha256(payload)))
                .encode();
        assertTrue(new String(cleanup, StandardCharsets.UTF_8).contains("\"phase\":\"cleanup\""));
    }

    @Test
    void rejectsCrossOperationAccessBeforeParsing() throws Exception {
        byte[] payload = "trusted-pdf".getBytes(StandardCharsets.UTF_8);
        FunctionRuntimeMain.SessionEngine engine =
                new FunctionRuntimeMain.SessionEngine(CLOCK);
        engine.handle(upload(payload, "operation_123"));

        FunctionRuntimeMain.ProtocolFailure failure = assertThrows(
                FunctionRuntimeMain.ProtocolFailure.class,
                () -> engine.handle(request(
                        "parse", "operation_456", sha256(payload))));
        assertEquals("authorization_denied", failure.getMessage());
        engine.handle(request("cleanup", "operation_123", sha256(payload)));
    }

    @Test
    void rejectsTrailingBytesOutsideTheDeclaredFrame() throws Exception {
        byte[] encoded = request(
                "parse", "operation_123", "a".repeat(64)).encode();
        byte[] mutated = java.util.Arrays.copyOf(encoded, encoded.length + 1);

        FunctionRuntimeMain.ProtocolFailure failure = assertThrows(
                FunctionRuntimeMain.ProtocolFailure.class,
                () -> FunctionRuntimeMain.Frame.decode(mutated));
        assertEquals("invalid_output", failure.getMessage());
    }

    private static FunctionRuntimeMain.Frame upload(
            byte[] payload, String operationId) throws Exception {
        Map<String, Object> header = new LinkedHashMap<>();
        header.put("action", "upload");
        header.put("chunkSha256", sha256(payload));
        header.put("contractVersion", FunctionRuntimeMain.CONTRACT);
        header.put("documentKind", "pdf");
        header.put("inputSha256", sha256(payload));
        header.put("operationId", operationId);
        header.put("processingLane", "standard");
        header.put("sequence", 0);
        header.put("totalBytes", payload.length);
        header.put("totalChunks", 1);
        header.put("workerArtifactDigest", "sha256:" + "b".repeat(64));
        return new FunctionRuntimeMain.Frame(header, payload);
    }

    private static FunctionRuntimeMain.Frame request(
            String action, String operationId, String inputSha256)
            throws Exception {
        Map<String, Object> header = new LinkedHashMap<>();
        header.put("action", action);
        header.put("contractVersion", FunctionRuntimeMain.CONTRACT);
        header.put("inputSha256", inputSha256);
        header.put("operationId", operationId);
        return new FunctionRuntimeMain.Frame(header, new byte[0]);
    }

    private static String sha256(byte[] value) throws Exception {
        return HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(value));
    }
}
