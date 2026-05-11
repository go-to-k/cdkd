def handler(event:, context:)
  {
    "echoed" => event,
    "greeting" => ENV.fetch("GREETING", "unset"),
  }
end
