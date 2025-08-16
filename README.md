# Project 5: Universal Knowledge-Graph Builder

## Description
Convert a document archive into an interactive knowledge graph with natural language Q&A support.

## Requirements
- Ingest TXT files and URLs (≤ 100 MB total)
- Build a graph of concepts with node/edge visualization
- Support natural language questions over the graph

# Knowledge Graph CLI with Neo4j Integration

Transform your document archives into an interactive knowledge graph with natural language Q&A support using Neo4j and Claude AI.

## 🚀 Features

- **📁 Multi-Source Ingestion**: Process TXT files and URLs (≤ 100 MB total)
- **🧠 Smart Knowledge Graph**: Automatic concept extraction and relationship mapping
- **🎯 Interactive Visualization**: Neo4j Browser integration for graph exploration
- **💬 Natural Language Q&A**: Ask questions about your documents in plain English
- **🔗 Neo4j Integration**: Enterprise-grade graph database with Cypher queries
- **🤖 Claude Code Support**: Terminal-based AI development assistance

## 📋 Prerequisites

- **Node.js** (v14 or higher)
- **Neo4j Database** (Aura Cloud or local installation)
- **Claude API Key** (for Claude Code integration)

## 🛠 Setup Instructions

### 1. Project Setup

```bash
# Navigate to project directory
cd /Users/sravan/src/buildathon/buildathon-project5

# Install dependencies
npm install neo4j-driver axios commander chalk ora dotenv

# Make CLI executable
chmod +x knowledge-graph.js
```

### 2. Environment Configuration

Create a `.env` file in your project root:

```bash
# Neo4j Configuration (Aura Cloud)
NEO4J_URL=neo4j+s://your-database-id.databases.neo4j.io
NEO4J_USER=neo4j
NEO4J_PASSWORD=your_neo4j_password
NEO4J_DATABASE=neo4j

# Claude API Configuration
ANTHROPIC_API_KEY=sk-ant-api03-your_anthropic_key

# Application Settings
MAX_FILE_SIZE_MB=100
DEFAULT_LANGUAGE=en
```

### 3. Claude Code CLI Setup

For enhanced development experience with AI assistance:

```bash
# Install Claude Code globally
npm install -g @anthropic-ai/claude-code

# Verify installation
claude --version

# Start Claude Code in project directory
claude
```

**First-time Authentication:**
- Choose "Anthropic Console" when prompted
- Complete OAuth process in browser
- Or set API key: `export ANTHROPIC_API_KEY=your_key`

## 🎯 Usage

### Basic Commands

```bash
# Connect to Neo4j
node knowledge-graph.js connect

# Ingest documents
node knowledge-graph.js ingest -f document1.txt document2.txt

# Ingest URLs
node knowledge-graph.js ingest -u https://example.com/article

# Query the knowledge graph
node knowledge-graph.js query "What is the main topic?"

# Interactive Q&A mode
node knowledge-graph.js interactive

# View graph statistics
node knowledge-graph.js stats
```

### Example Workflow

```bash
# 1. Connect to Neo4j Aura
node knowledge-graph.js connect

# 2. Clear existing data and ingest new documents
node knowledge-graph.js ingest --clear -f research_paper.txt

# 3. Add web content
node knowledge-graph.js ingest -u https://en.wikipedia.org/wiki/Artificial_intelligence

# 4. Start interactive Q&A session
node knowledge-graph.js interactive
```

### Using Claude Code for Development

```bash
# Start Claude Code in project directory
claude

# Example prompts for Claude Code:
# "Help me debug the Neo4j connection in knowledge-graph.js"
# "Add error handling to the file ingestion process"
# "Create unit tests for the concept extraction function"
# "Optimize the Cypher queries for better performance"
```

## 🗄 Neo4j Database Schema

The application creates the following node types and relationships:

### Nodes
- **Document**: Represents uploaded files or URLs
  - Properties: `id`, `name`, `content`, `type`, `size`, `createdAt`
- **Concept**: Extracted concepts from documents
  - Properties: `name`, `frequency`, `createdAt`

### Relationships
- **CONTAINS**: Document → Concept
- **RELATED_TO**: Concept ↔ Concept (weighted by co-occurrence)

### Sample Cypher Queries

```cypher
// View all nodes and relationships
MATCH (n) RETURN n LIMIT 25

// Find most connected concepts
MATCH (c:Concept)
OPTIONAL MATCH (c)-[r:RELATED_TO]-()
RETURN c.name, c.frequency, COUNT(r) as connections
ORDER BY connections DESC, c.frequency DESC
LIMIT 10

// Search for documents containing specific concepts
MATCH (d:Document)-[:CONTAINS]->(c:Concept)
WHERE c.name CONTAINS 'intelligence'
RETURN d.name, COLLECT(c.name) as concepts
```

## 🔧 Advanced Configuration

### Custom Neo4j Connection

```bash
# Connect with custom parameters
node knowledge-graph.js connect \
  -u neo4j+s://your-custom-uri \
  --username your_username \
  --password your_password \
  -d your_database
```

### Batch Processing

```bash
# Process all TXT files in a directory
find ./documents -name "*.txt" -exec node knowledge-graph.js ingest -f {} +
```

## 🌐 Neo4j Browser Exploration

Access Neo4j Browser at: `https://browser.neo4j.io/`

Connect using your Neo4j Aura credentials to visualize and explore the knowledge graph interactively.

## 📊 Project Structure

```
buildathon-project5/
├── knowledge-graph.js     # Main CLI application
├── package.json          # Dependencies and scripts
├── .env                  # Environment variables (not in git)
├── .gitignore           # Git ignore rules
├── README.md            # This file
├── documents/           # Sample documents directory
└── examples/            # Example queries and workflows
```

## 🔍 Troubleshooting

### Connection Issues
- Verify Neo4j Aura is running and accessible
- Check credentials in `.env` file
- Ensure network connectivity to Aura Cloud

### Performance Optimization
- Use indexes for frequently queried properties
- Process large documents in smaller batches
- Monitor memory usage with `node --max-old-space-size=4096`

### Claude Code Issues
- Update to latest version: `npm update -g @anthropic-ai/claude-code`
- Clear authentication: `claude logout` then `claude`
- Check API usage at console.anthropic.com

## 🚀 Development with Claude Code

This project is optimized for development with Claude Code. Some useful patterns:

```bash
# Start Claude Code for assistance
claude

# Common development prompts:
"Add comprehensive error handling to all Neo4j operations"
"Create a configuration validator for environment variables"
"Implement caching for frequently accessed concepts"
"Add progress bars for long-running operations"
"Create integration tests for the CLI commands"
```

## 📄 License

MIT License - feel free to use this project for your own knowledge graph applications.

## 🤝 Contributing

This project was built during a buildathon. Contributions and improvements are welcome!

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test with sample documents
5. Submit a pull request

