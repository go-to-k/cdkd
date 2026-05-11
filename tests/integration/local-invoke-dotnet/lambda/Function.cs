using System;
using System.Collections.Generic;
using Amazon.Lambda.Core;

[assembly: LambdaSerializer(typeof(Amazon.Lambda.Serialization.SystemTextJson.DefaultLambdaJsonSerializer))]

namespace Function {
    public class Handler {
        public Dictionary<string, object> HandleRequest(Dictionary<string, object> input, ILambdaContext context) {
            return new Dictionary<string, object> {
                { "echoed", input ?? new Dictionary<string, object>() },
                { "greeting", Environment.GetEnvironmentVariable("GREETING") ?? "unset" }
            };
        }
    }
}
