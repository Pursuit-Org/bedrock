# Pursuit MCP Client

A Python client for connecting to Model Context Protocol (MCP) servers, with built-in support for Slack, Salesforce, and Google Drive integrations.

## 🚀 Features

- **Multi-Service Support**: Connect to Slack, Salesforce, and Google Drive through MCP servers
- **Unified Interface**: Single client to manage all your service connections
- **Async/Await Support**: Built with modern Python async patterns
- **Transport Flexibility**: Supports WebSocket and stdio transports
- **Authentication Handling**: Built-in OAuth and API key management
- **Error Handling**: Robust error handling with fallback mechanisms
- **Type Safety**: Full type hints and Pydantic models

## 📦 Installation

Use Python 3.10 or newer. Before installing dependencies into a new or existing
environment, [update pip to 26.2.2 or newer using the hash-pinned bootstrap](https://discuss.python.org/t/information-for-python-users-regarding-emudhra-emsign-ca-certificate-security-incident/109576)
so its bundled certificate store no longer trusts the affected emSign root.

1. Clone the repository:
```bash
git clone <repository-url>
cd pursuit-mcp-client
```

2. Create or check the root virtual environment, bootstrap patched pip, and install
the MCP client in development mode:
```bash
bash scripts/install.sh
```

3. Activate that environment before running the client:
```bash
source venv/bin/activate
```

## ⚙️ Configuration

1. Copy the environment template:
```bash
cp .env.example .env
```

2. Fill in your credentials in `.env`:

### Slack Configuration
```env
SLACK_BOT_TOKEN=xoxb-your-slack-bot-token
SLACK_TEAM_ID=your-slack-team-id
```

### Salesforce Configuration
```env
SALESFORCE_USERNAME=your-salesforce-username
SALESFORCE_PASSWORD=your-salesforce-password
SALESFORCE_SECURITY_TOKEN=your-security-token
SALESFORCE_DOMAIN=login  # or test for sandbox
```

### Google Drive Configuration
```env
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_REDIRECT_URI=http://localhost:8080/callback
```

## 🎯 Quick Start

### Basic Usage

```python
import asyncio
from mcp_client import UnifiedMCPClient

async def main():
    client = UnifiedMCPClient()
    
    try:
        # Connect to services
        slack = await client.connect_slack("ws://localhost:8001/mcp/slack")
        salesforce = await client.connect_salesforce("ws://localhost:8002/mcp/salesforce")
        gdrive = await client.connect_google_drive("ws://localhost:8003/mcp/gdrive")
        
        # Use the services
        channels = await slack.get_channels()
        accounts = await salesforce.query("SELECT Id, Name FROM Account LIMIT 5")
        files = await gdrive.list_files(page_size=10)
        
        print(f"Found {len(channels)} Slack channels")
        print(f"Found {accounts['totalSize']} Salesforce accounts")
        print(f"Found {len(files['files'])} Google Drive files")
        
    finally:
        await client.disconnect_all()

asyncio.run(main())
```

### Service-Specific Usage

#### Slack
```python
# Connect to Slack
slack = await client.connect_slack("stdio")

# Post a message
await slack.post_message("#general", "Hello from MCP Client! 🤖")

# Get channels
channels = await slack.get_channels(limit=10)

# Search messages
results = await slack.search_messages("important", count=20)
```

#### Salesforce
```python
# Connect to Salesforce
salesforce = await client.connect_salesforce("stdio")

# Query records
accounts = await salesforce.query("SELECT Id, Name FROM Account LIMIT 10")

# Create a record
new_account = await salesforce.create_record("Account", {
    "Name": "Test Account",
    "Type": "Prospect"
})

# Update a record
await salesforce.update_record("Account", account_id, {
    "Description": "Updated via MCP"
})
```

#### Google Drive
```python
# Connect to Google Drive
gdrive = await client.connect_google_drive("stdio")

# List files
files = await gdrive.list_files(page_size=20)

# Upload a file
await gdrive.upload_file(
    name="test.txt",
    content=b"Hello, world!",
    mime_type="text/plain"
)

# Create a folder
folder = await gdrive.create_folder("My New Folder")
```

## 📁 Project Structure

```
pursuit-mcp-client/
├── mcp_client/
│   ├── __init__.py          # Main exports
│   ├── client.py            # Core MCP client
│   ├── transport.py         # Transport layer (WebSocket, stdio)
│   ├── types.py             # Type definitions
│   ├── unified_client.py    # Unified client interface
│   └── services/
│       ├── __init__.py
│       ├── base.py          # Base service class
│       ├── slack.py         # Slack integration
│       ├── salesforce.py    # Salesforce integration
│       └── google_drive.py  # Google Drive integration
├── examples/
│   ├── basic_usage.py       # Basic usage example
│   ├── slack_example.py     # Slack-specific example
│   ├── salesforce_example.py # Salesforce-specific example
│   └── google_drive_example.py # Google Drive-specific example
├── config/
│   └── mcp_servers.json     # MCP server configurations
├── requirements.txt         # Python dependencies
├── pyproject.toml          # Project configuration
└── README.md               # This file
```

## 🔧 MCP Server Setup

This client requires MCP servers to be running for each service. You can:

1. **Use existing MCP servers**:
   - [Slack MCP Server](https://mcpmarket.com/server/slack)
   - [Salesforce MCP Server](https://viasocket.com/mcp/salesforce)
   - [Google Workspace MCP Server](https://workspacemcp.com/)

2. **Run servers locally** using the provided configurations in `config/mcp_servers.json`

3. **Use stdio transport** if you have command-line MCP tools

## 🧪 Examples

Run the example scripts to see the client in action:

```bash
# Basic usage with all services
python examples/basic_usage.py

# Service-specific examples
python examples/slack_example.py
python examples/salesforce_example.py
python examples/google_drive_example.py
```

## 🛠️ Development

### Setting up for Development

Complete the installation above and activate `venv` before adding development
dependencies, so these downloads also use the patched pip trust store.

```bash
# Install development dependencies
python -m pip install -e ".[dev]"

# Run tests
pytest

# Format code
black mcp_client/

# Type checking
mypy mcp_client/
```

### Transport Options

The client supports multiple transport mechanisms:

1. **WebSocket**: `ws://localhost:8001/mcp/service`
2. **Stdio**: `"stdio"` (for command-line MCP tools)
3. **Custom Transport**: Implement the `Transport` interface

## 🔐 Authentication

### Slack
- Create a Slack app at https://api.slack.com/apps
- Add bot scopes: `chat:write`, `channels:read`, `users:read`, etc.
- Install the app to your workspace
- Copy the Bot User OAuth Token

### Salesforce
- Use your Salesforce username and password
- Generate a security token from Setup > Personal Information > Reset Security Token
- For sandbox, use `test.salesforce.com` as domain

### Google Drive
- Create a project in Google Cloud Console
- Enable the Google Drive API
- Create OAuth 2.0 credentials
- Download the credentials file or use client ID/secret

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Run the test suite
6. Submit a pull request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🆘 Support

For issues and questions:

1. Check the [examples](./examples/) directory
2. Review the [configuration](./config/) files
3. Open an issue on GitHub

## 🔮 Roadmap

- [ ] Add more service integrations (Teams, Discord, etc.)
- [ ] Implement connection pooling
- [ ] Add retry mechanisms with exponential backoff
- [ ] Create a web UI for configuration
- [ ] Add comprehensive logging
- [ ] Support for MCP server discovery
- [ ] Plugin architecture for custom services

---

**Happy coding! 🚀**
