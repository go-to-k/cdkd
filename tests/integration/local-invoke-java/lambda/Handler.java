import java.util.HashMap;
import java.util.Map;

/**
 * Minimal Lambda Java handler for cdkd local invoke integ test.
 * No external dependencies (Lambda Java runtime supplies Jackson for
 * de/serialization of `Object` arguments — no `aws-lambda-java-core`
 * needed for this handler signature).
 */
public class Handler {
  public Map<String, Object> handleRequest(Object input) {
    Map<String, Object> result = new HashMap<>();
    result.put("echoed", input);
    result.put("greeting", System.getenv().getOrDefault("GREETING", "unset"));
    return result;
  }
}
