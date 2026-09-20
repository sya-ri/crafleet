package dev.s7a.crafleet.console;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Reader;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.function.Function;

/** Outbound, loopback-only completion transport. It never dispatches commands. */
public final class Bridge implements AutoCloseable {
    public static final class Suggestion {
        public final int start;
        public final int end;
        public final String text;

        public Suggestion(int start, int end, String text) {
            this.start = start;
            this.end = end;
            this.text = text;
        }
    }

    public static final class Request {
        public final String line;
        public final int cursor;

        Request(String line, int cursor) {
            this.line = line;
            this.cursor = cursor;
        }

        public String prefix() {
            return line.substring(0, cursor);
        }
    }

    private final String kind;
    private final String version;
    private final Function<Request, CompletableFuture<List<Suggestion>>> complete;
    private final ConcurrentMap<String, CompletableFuture<List<Suggestion>>> requests =
            new ConcurrentHashMap<>();
    private volatile boolean closed;
    private volatile Socket socket;
    private Thread thread;

    public Bridge(
            String kind,
            String version,
            Function<Request, CompletableFuture<List<Suggestion>>> complete) {
        this.kind = kind;
        this.version = version;
        this.complete = complete;
    }

    public void start() {
        final String token = System.getenv("CRAFLEET_CONSOLE_TOKEN");
        final String port = System.getenv("CRAFLEET_CONSOLE_PORT");
        if (token == null || port == null) {
            return;
        }
        thread = new Thread(() -> connect(port, token), "crafleet-console-bridge");
        thread.setDaemon(true);
        thread.start();
    }

    private void connect(String port, String token) {
        while (!closed) {
            try (Socket connection = new Socket()) {
                socket = connection;
                connection.connect(
                        new InetSocketAddress("127.0.0.1", Integer.parseInt(port)), 2000);
                serve(connection, token);
            } catch (IOException | IllegalArgumentException ignored) {
                // A runner restart/disconnect must not stop the Minecraft server.
            } finally {
                cancelRequests();
            }
            if (!closed) {
                try {
                    Thread.sleep(1000);
                } catch (InterruptedException ignored) {
                    return;
                }
            }
        }
    }

    private void serve(Socket connection, String token) throws IOException {
        connection.setSoTimeout(3000);
        BufferedWriter writer =
                new BufferedWriter(
                        new OutputStreamWriter(
                                connection.getOutputStream(), StandardCharsets.UTF_8));
        Reader reader = new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8);
        send(writer, "HELLO\t1\t" + token + "\t" + version + "\t" + kind);
        if (!"READY\t1".equals(readLine(reader))) {
            throw new IOException("Handshake rejected");
        }
        connection.setSoTimeout(0);
        String line;
        while (!closed && (line = readLine(reader)) != null) {
            String[] parts = line.split("\t", -1);
            if (parts.length == 2 && parts[0].equals("CANCEL")) {
                CompletableFuture<?> pending = requests.remove(parts[1]);
                if (pending != null) {
                    pending.cancel(false);
                }
            } else if (parts.length == 4 && parts[0].equals("COMPLETE")) {
                completeRequest(connection, writer, parts);
            } else {
                throw new IOException("Invalid request");
            }
        }
    }

    private void completeRequest(Socket connection, BufferedWriter writer, String[] parts)
            throws IOException {
        String id = parts[1];
        if (requests.size() >= 32 || !id.matches("[a-f0-9-]{36}")) {
            send(writer, "ERROR\t" + id);
            return;
        }
        try {
            String input = new String(Base64.getDecoder().decode(parts[3]), StandardCharsets.UTF_8);
            int cursor = Integer.parseInt(parts[2]);
            if (input.length() > 8192
                    || cursor < 0
                    || cursor > input.length()
                    || input.matches("(?s).*[\\x00-\\x1f\\x7f-\\x9f].*")) {
                throw new IllegalArgumentException();
            }
            CompletableFuture<List<Suggestion>> future = complete.apply(new Request(input, cursor));
            requests.put(id, future);
            future.whenComplete(
                    (suggestions, failure) -> {
                        if (!requests.remove(id, future) || closed) {
                            return;
                        }
                        try {
                            send(writer, response(id, suggestions, failure));
                        } catch (IOException ignored) {
                            closeSocket(connection);
                        }
                    });
        } catch (Throwable failure) {
            send(writer, "ERROR\t" + id);
        }
    }

    private static String response(String id, List<Suggestion> suggestions, Throwable failure) {
        StringBuilder response =
                new StringBuilder(failure == null ? "RESULT\t" : "ERROR\t").append(id);
        if (failure == null && suggestions != null) {
            int count = 0;
            for (Suggestion suggestion : suggestions) {
                if (count++ >= 256 || suggestion.text == null || suggestion.text.length() > 8192) {
                    break;
                }
                String encoded =
                        Base64.getEncoder()
                                .encodeToString(suggestion.text.getBytes(StandardCharsets.UTF_8));
                String field = "\t" + suggestion.start + ":" + suggestion.end + ":" + encoded;
                if (response.length() + field.length() > 60000) {
                    break;
                }
                response.append(field);
            }
        }
        return response.toString();
    }

    private static String readLine(Reader reader) throws IOException {
        StringBuilder line = new StringBuilder();
        int ch;
        while ((ch = reader.read()) != -1) {
            if (ch == '\n') {
                return line.toString();
            }
            if (line.length() >= 65536) {
                throw new IOException("Frame too large");
            }
            line.append((char) ch);
        }
        return null;
    }

    private static void send(BufferedWriter writer, String text) throws IOException {
        synchronized (writer) {
            writer.write(text);
            writer.write('\n');
            writer.flush();
        }
    }

    private void cancelRequests() {
        for (CompletableFuture<?> future : requests.values()) {
            future.cancel(false);
        }
        requests.clear();
    }

    private static void closeSocket(Socket connection) {
        try {
            connection.close();
        } catch (IOException ignored) {
            // Closing a failed or stopped connection is best effort.
        }
    }

    @Override
    public void close() {
        closed = true;
        cancelRequests();
        if (thread != null) {
            thread.interrupt();
        }
        if (socket != null) {
            closeSocket(socket);
        }
    }
}
