// Minimal Lambda handler for `provided.al2023` integ test.
// Compiled inside Docker (no Go toolchain required on the host) to a
// statically-linked `bootstrap` binary that the OS-only Lambda runtime
// invokes via the Lambda Runtime API.
package main

import (
	"context"
	"os"

	"github.com/aws/aws-lambda-go/lambda"
)

type Response struct {
	Echoed   map[string]interface{} `json:"echoed"`
	Greeting string                 `json:"greeting"`
}

func handler(_ context.Context, event map[string]interface{}) (Response, error) {
	if event == nil {
		event = map[string]interface{}{}
	}
	greeting := os.Getenv("GREETING")
	if greeting == "" {
		greeting = "unset"
	}
	return Response{Echoed: event, Greeting: greeting}, nil
}

func main() {
	lambda.Start(handler)
}
