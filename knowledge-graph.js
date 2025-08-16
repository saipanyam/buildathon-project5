#!/usr/bin/env node

require('dotenv').config();
const { program } = require('commander');
const neo4j = require('neo4j-driver');
const fs = require('fs-extra');
const axios = require('axios');
const chalk = require('chalk');
// Simple spinner replacement for ora compatibility
const ora = (text) => ({
  start: () => { 
    console.log(`⏳ ${text}`); 
    return { 
      text, 
      succeed: (msg) => console.log(`✅ ${msg}`), 
      fail: (msg) => console.log(`❌ ${msg}`) 
    }; 
  }
});
const natural = require('natural');
const cheerio = require('cheerio');
const readlineSync = require('readline-sync');
const path = require('path');

// Global Neo4j driver and session
let driver = null;
let session = null;

// Knowledge Graph Class
class KnowledgeGraph {
  constructor() {
    this.maxFileSize = parseInt(process.env.MAX_FILE_SIZE_MB || '100') * 1024 * 1024;
    this.stemmer = natural.PorterStemmer;
    this.tokenizer = new natural.WordTokenizer();
  }

  async connect(uri, username, password, database) {
    try {
      driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
      await driver.verifyConnectivity();
      session = driver.session({ database });
      return true;
    } catch (error) {
      console.error(chalk.red('Failed to connect to Neo4j:'), error.message);
      return false;
    }
  }

  async initializeSchema() {
    const spinner = ora('Initializing Neo4j schema...').start();
    try {
      // Create constraints and indexes
      await session.run('CREATE CONSTRAINT doc_id IF NOT EXISTS FOR (d:Document) REQUIRE d.id IS UNIQUE');
      await session.run('CREATE CONSTRAINT concept_name IF NOT EXISTS FOR (c:Concept) REQUIRE c.name IS UNIQUE');
      await session.run('CREATE INDEX doc_name IF NOT EXISTS FOR (d:Document) ON (d.name)');
      await session.run('CREATE INDEX concept_freq IF NOT EXISTS FOR (c:Concept) ON (c.frequency)');
      
      spinner.succeed('Schema initialized successfully');
      return true;
    } catch (error) {
      spinner.fail('Failed to initialize schema');
      console.error(chalk.red('Error:'), error.message);
      return false;
    }
  }

  async extractConcepts(text) {
    // Tokenize and clean text
    const tokens = this.tokenizer.tokenize(text.toLowerCase());
    const filteredTokens = tokens.filter(token => 
      token.length > 2 && 
      !/^\d+$/.test(token) && 
      !natural.stopwords.includes(token)
    );

    // Count word frequencies
    const wordFreq = {};
    filteredTokens.forEach(token => {
      const stemmed = this.stemmer.stem(token);
      wordFreq[stemmed] = (wordFreq[stemmed] || 0) + 1;
    });

    // Extract meaningful concepts (frequency > 1 or length > 4)
    const concepts = Object.entries(wordFreq)
      .filter(([word, freq]) => freq > 1 || word.length > 4)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50) // Top 50 concepts
      .map(([word, freq]) => ({ name: word, frequency: freq }));

    return concepts;
  }

  async ingestFile(filePath, clear = false) {
    const spinner = ora(`Processing file: ${path.basename(filePath)}`).start();
    
    try {
      // Check file size
      const stats = await fs.stat(filePath);
      if (stats.size > this.maxFileSize) {
        spinner.fail(`File too large: ${(stats.size / 1024 / 1024).toFixed(2)}MB (max: ${this.maxFileSize / 1024 / 1024}MB)`);
        return false;
      }

      // Read file content
      const content = await fs.readFile(filePath, 'utf-8');
      
      // Clear existing data if requested
      if (clear) {
        await session.run('MATCH (n) DETACH DELETE n');
        spinner.text = 'Cleared existing data, processing file...';
      }

      // Extract concepts
      const concepts = await this.extractConcepts(content);
      
      // Create document node
      const docId = path.basename(filePath) + '_' + Date.now();
      await session.run(
        'CREATE (d:Document {id: $id, name: $name, content: $content, type: "file", size: $size, createdAt: datetime()})'
        , { id: docId, name: path.basename(filePath), content: content.substring(0, 1000), size: stats.size }
      );

      // Create concept nodes and relationships
      for (const concept of concepts) {
        await session.run(
          `MERGE (c:Concept {name: $name})
           ON CREATE SET c.frequency = $frequency, c.createdAt = datetime()
           ON MATCH SET c.frequency = c.frequency + $frequency`,
          concept
        );
        
        await session.run(
          'MATCH (d:Document {id: $docId}), (c:Concept {name: $conceptName}) CREATE (d)-[:CONTAINS {frequency: $frequency}]->(c)',
          { docId, conceptName: concept.name, frequency: concept.frequency }
        );
      }

      // Create concept relationships based on co-occurrence
      await this.createConceptRelationships(concepts);

      spinner.succeed(`Successfully processed: ${path.basename(filePath)} (${concepts.length} concepts extracted)`);
      return true;

    } catch (error) {
      spinner.fail(`Failed to process file: ${error.message}`);
      return false;
    }
  }

  async ingestUrl(url, clear = false) {
    const spinner = ora(`Fetching content from: ${url}`).start();
    
    try {
      // Fetch web content
      const response = await axios.get(url, { timeout: 30000 });
      const $ = cheerio.load(response.data);
      
      // Extract text content
      $('script, style, nav, header, footer').remove();
      const content = $('body').text().replace(/\s+/g, ' ').trim();
      
      if (content.length === 0) {
        spinner.fail('No text content found at URL');
        return false;
      }

      // Check content size
      if (content.length > this.maxFileSize) {
        spinner.fail(`Content too large: ${(content.length / 1024 / 1024).toFixed(2)}MB`);
        return false;
      }

      // Clear existing data if requested
      if (clear) {
        await session.run('MATCH (n) DETACH DELETE n');
        spinner.text = 'Cleared existing data, processing URL...';
      }

      // Extract concepts
      const concepts = await this.extractConcepts(content);
      
      // Create document node
      const docId = 'url_' + Buffer.from(url).toString('base64').substring(0, 10) + '_' + Date.now();
      await session.run(
        'CREATE (d:Document {id: $id, name: $name, content: $content, type: "url", url: $url, size: $size, createdAt: datetime()})'
        , { id: docId, name: url, content: content.substring(0, 1000), url, size: content.length }
      );

      // Create concept nodes and relationships
      for (const concept of concepts) {
        await session.run(
          `MERGE (c:Concept {name: $name})
           ON CREATE SET c.frequency = $frequency, c.createdAt = datetime()
           ON MATCH SET c.frequency = c.frequency + $frequency`,
          concept
        );
        
        await session.run(
          'MATCH (d:Document {id: $docId}), (c:Concept {name: $conceptName}) CREATE (d)-[:CONTAINS {frequency: $frequency}]->(c)',
          { docId, conceptName: concept.name, frequency: concept.frequency }
        );
      }

      // Create concept relationships
      await this.createConceptRelationships(concepts);

      spinner.succeed(`Successfully processed URL: ${url} (${concepts.length} concepts extracted)`);
      return true;

    } catch (error) {
      spinner.fail(`Failed to fetch URL: ${error.message}`);
      return false;
    }
  }

  async createConceptRelationships(concepts) {
    // Create relationships between concepts that appear together
    for (let i = 0; i < concepts.length; i++) {
      for (let j = i + 1; j < concepts.length; j++) {
        const weight = Math.min(concepts[i].frequency, concepts[j].frequency);
        await session.run(
          `MATCH (c1:Concept {name: $name1}), (c2:Concept {name: $name2})
           MERGE (c1)-[r:RELATED_TO]-(c2)
           ON CREATE SET r.weight = $weight
           ON MATCH SET r.weight = r.weight + $weight`,
          { name1: concepts[i].name, name2: concepts[j].name, weight }
        );
      }
    }
  }

  async queryGraph(question) {
    try {
      // Extract key terms from question
      const questionTokens = this.tokenizer.tokenize(question.toLowerCase());
      const keyTerms = questionTokens
        .filter(token => !natural.stopwords.includes(token) && token.length > 2)
        .map(token => this.stemmer.stem(token));

      if (keyTerms.length === 0) {
        return 'Please provide a more specific question with meaningful terms.';
      }

      // Find relevant concepts
      const conceptQuery = `
        MATCH (c:Concept)
        WHERE ANY(term IN $terms WHERE c.name CONTAINS term)
        RETURN c.name as concept, c.frequency as frequency
        ORDER BY c.frequency DESC
        LIMIT 10
      `;
      
      const conceptResult = await session.run(conceptQuery, { terms: keyTerms });
      const relevantConcepts = conceptResult.records.map(record => ({
        name: record.get('concept'),
        frequency: record.get('frequency')
      }));

      if (relevantConcepts.length === 0) {
        return 'No relevant concepts found in the knowledge graph for your question.';
      }

      // Find documents containing these concepts
      const docQuery = `
        MATCH (d:Document)-[r:CONTAINS]->(c:Concept)
        WHERE c.name IN $concepts
        RETURN d.name as document, d.content as content, d.type as type, 
               COLLECT(c.name) as concepts, SUM(r.frequency) as relevance
        ORDER BY relevance DESC
        LIMIT 5
      `;
      
      const docResult = await session.run(docQuery, { 
        concepts: relevantConcepts.map(c => c.name) 
      });
      
      const relevantDocs = docResult.records.map(record => ({
        name: record.get('document'),
        content: record.get('content'),
        type: record.get('type'),
        concepts: record.get('concepts'),
        relevance: record.get('relevance')
      }));

      // Build response
      let response = `Based on your question about "${question}", here's what I found:\n\n`;
      
      response += `🔍 **Relevant Concepts:**\n`;
      relevantConcepts.slice(0, 5).forEach(concept => {
        response += `   • ${concept.name} (frequency: ${concept.frequency})\n`;
      });
      
      response += `\n📄 **Related Documents:**\n`;
      relevantDocs.forEach((doc, index) => {
        response += `   ${index + 1}. ${doc.name} (${doc.type})\n`;
        response += `      Preview: ${doc.content.substring(0, 200)}...\n`;
        response += `      Key concepts: ${doc.concepts.slice(0, 3).join(', ')}\n\n`;
      });

      return response;

    } catch (error) {
      return `Error querying knowledge graph: ${error.message}`;
    }
  }

  async getStats() {
    try {
      const stats = {};
      
      // Count documents
      const docResult = await session.run('MATCH (d:Document) RETURN COUNT(d) as count');
      stats.documents = docResult.records[0].get('count').toNumber();
      
      // Count concepts
      const conceptResult = await session.run('MATCH (c:Concept) RETURN COUNT(c) as count');
      stats.concepts = conceptResult.records[0].get('count').toNumber();
      
      // Count relationships
      const relResult = await session.run('MATCH ()-[r:RELATED_TO]-() RETURN COUNT(r) as count');
      stats.relationships = relResult.records[0].get('count').toNumber();
      
      // Top concepts
      const topResult = await session.run(
        'MATCH (c:Concept) RETURN c.name as name, c.frequency as frequency ORDER BY c.frequency DESC LIMIT 10'
      );
      stats.topConcepts = topResult.records.map(record => ({
        name: record.get('name'),
        frequency: record.get('frequency')
      }));
      
      return stats;
    } catch (error) {
      throw new Error(`Failed to get stats: ${error.message}`);
    }
  }

  async close() {
    if (session) await session.close();
    if (driver) await driver.close();
  }
}

const kg = new KnowledgeGraph();

// Set up the CLI program
program
  .name('knowledge-graph')
  .description('Knowledge Graph CLI for Neo4j and AI integration')
  .version('1.0.0');

// Connect command - Test Neo4j database connection
program
  .command('connect')
  .description('Connect to Neo4j database')
  .option('-u, --uri <uri>', 'Neo4j URI', process.env.NEO4J_URL || 'bolt://localhost:7687')
  .option('--username <username>', 'Username', process.env.NEO4J_USER || 'neo4j')
  .option('--password <password>', 'Password', process.env.NEO4J_PASSWORD || 'password')
  .option('-d, --database <database>', 'Database name', process.env.NEO4J_DATABASE || 'neo4j')
  .action(async (options) => {
    console.log(chalk.blue('🔗 Connecting to Neo4j...'));
    console.log(`URI: ${options.uri}`);
    console.log(`Database: ${options.database}`);
    console.log(`Username: ${options.username}`);
    
    const success = await kg.connect(options.uri, options.username, options.password, options.database);
    
    if (success) {
      console.log(chalk.green('✅ Successfully connected to Neo4j database!'));
      
      // Initialize schema
      await kg.initializeSchema();
      
      // Test a simple query
      const result = await session.run('RETURN "Hello Neo4j!" as message');
      const message = result.records[0].get('message');
      console.log(chalk.cyan(`💬 Test Query Result: ${message}`));
      
      await kg.close();
    } else {
      console.log(chalk.yellow('\n🔍 Troubleshooting:'));
      console.log('- Check your NEO4J_URL, NEO4J_USER, and NEO4J_PASSWORD in .env');
      console.log('- Verify credentials in Neo4j Aura console');
      console.log('- Ensure network connectivity to Neo4j Aura');
      process.exit(1);
    }
  });

// Ingest command - Process files and URLs
program
  .command('ingest')
  .description('Ingest documents and URLs into the knowledge graph')
  .option('-f, --files <files...>', 'TXT files to process')
  .option('-u, --urls <urls...>', 'URLs to process')
  .option('--clear', 'Clear existing data before ingesting')
  .action(async (options) => {
    const { files, urls, clear } = options;
    
    if (!files && !urls) {
      console.error(chalk.red('❌ Please specify files (-f) or URLs (-u) to ingest'));
      process.exit(1);
    }

    // Connect to Neo4j
    const connected = await kg.connect(
      process.env.NEO4J_URL || 'bolt://localhost:7687',
      process.env.NEO4J_USER || 'neo4j',
      process.env.NEO4J_PASSWORD || 'password',
      process.env.NEO4J_DATABASE || 'neo4j'
    );

    if (!connected) {
      console.error(chalk.red('❌ Failed to connect to Neo4j'));
      process.exit(1);
    }

    await kg.initializeSchema();

    let totalProcessed = 0;
    let isFirstItem = true;

    // Process files
    if (files) {
      for (const file of files) {
        const success = await kg.ingestFile(file, clear && isFirstItem);
        if (success) totalProcessed++;
        isFirstItem = false;
      }
    }

    // Process URLs
    if (urls) {
      for (const url of urls) {
        const success = await kg.ingestUrl(url, clear && isFirstItem);
        if (success) totalProcessed++;
        isFirstItem = false;
      }
    }

    console.log(chalk.green(`\n🎉 Ingestion complete! Processed ${totalProcessed} items.`));
    console.log(chalk.cyan('💡 Use "node knowledge-graph.js stats" to view graph statistics'));
    console.log(chalk.cyan('💡 Use "node knowledge-graph.js query <question>" to ask questions'));
    
    await kg.close();
  });

// Query command - Ask natural language questions
program
  .command('query <question>')
  .description('Ask a natural language question about the knowledge graph')
  .action(async (question) => {
    const connected = await kg.connect(
      process.env.NEO4J_URL || 'bolt://localhost:7687',
      process.env.NEO4J_USER || 'neo4j',
      process.env.NEO4J_PASSWORD || 'password',
      process.env.NEO4J_DATABASE || 'neo4j'
    );

    if (!connected) {
      console.error(chalk.red('❌ Failed to connect to Neo4j'));
      process.exit(1);
    }

    console.log(chalk.blue(`🤔 Processing question: "${question}"\n`));
    
    const answer = await kg.queryGraph(question);
    console.log(answer);
    
    await kg.close();
  });

// Interactive command - Start interactive Q&A session
program
  .command('interactive')
  .description('Start interactive Q&A session')
  .action(async () => {
    console.log(chalk.blue('🚀 Starting interactive Q&A session...'));
    console.log(chalk.yellow('Type "exit" or "quit" to end the session\n'));

    const connected = await kg.connect(
      process.env.NEO4J_URL || 'bolt://localhost:7687',
      process.env.NEO4J_USER || 'neo4j',
      process.env.NEO4J_PASSWORD || 'password',
      process.env.NEO4J_DATABASE || 'neo4j'
    );

    if (!connected) {
      console.error(chalk.red('❌ Failed to connect to Neo4j'));
      process.exit(1);
    }

    while (true) {
      const question = readlineSync.question(chalk.cyan('❓ Your question: '));
      
      if (question.toLowerCase() === 'exit' || question.toLowerCase() === 'quit') {
        console.log(chalk.green('👋 Goodbye!'));
        break;
      }
      
      if (question.trim() === '') {
        console.log(chalk.yellow('Please enter a question or "exit" to quit.\n'));
        continue;
      }

      console.log(chalk.blue('\n🤔 Thinking...\n'));
      const answer = await kg.queryGraph(question);
      console.log(answer);
      console.log(chalk.gray('─'.repeat(60) + '\n'));
    }
    
    await kg.close();
  });

// Stats command - Show graph statistics
program
  .command('stats')
  .description('Show knowledge graph statistics')
  .action(async () => {
    const connected = await kg.connect(
      process.env.NEO4J_URL || 'bolt://localhost:7687',
      process.env.NEO4J_USER || 'neo4j',
      process.env.NEO4J_PASSWORD || 'password',
      process.env.NEO4J_DATABASE || 'neo4j'
    );

    if (!connected) {
      console.error(chalk.red('❌ Failed to connect to Neo4j'));
      process.exit(1);
    }

    try {
      const stats = await kg.getStats();
      
      console.log(chalk.blue('📊 Knowledge Graph Statistics\n'));
      console.log(chalk.green(`📄 Documents: ${stats.documents}`));
      console.log(chalk.green(`🧠 Concepts: ${stats.concepts}`));
      console.log(chalk.green(`🔗 Relationships: ${stats.relationships}`));
      
      if (stats.topConcepts.length > 0) {
        console.log(chalk.blue('\n🔥 Top Concepts:'));
        stats.topConcepts.forEach((concept, index) => {
          console.log(chalk.cyan(`   ${index + 1}. ${concept.name} (frequency: ${concept.frequency})`));
        });
      }
      
      console.log(chalk.yellow('\n💡 Tip: Visit https://browser.neo4j.io/ to visualize your graph'));
      
    } catch (error) {
      console.error(chalk.red('❌ Failed to get statistics:'), error.message);
    }
    
    await kg.close();
  });

// Status command - Show configuration and environment
program
  .command('status')
  .description('Show current configuration and environment status')
  .action(() => {
    console.log(chalk.blue('📋 Knowledge Graph CLI Status\n'));
    
    // Neo4j Configuration
    console.log(chalk.green('🗄️  Neo4j Configuration:'));
    console.log(`   URL: ${process.env.NEO4J_URL || chalk.red('Not set')}`);
    console.log(`   User: ${process.env.NEO4J_USER || chalk.red('Not set')}`);
    console.log(`   Database: ${process.env.NEO4J_DATABASE || chalk.red('Not set')}`);
    console.log(`   Password: ${process.env.NEO4J_PASSWORD ? chalk.green('✅ Set') : chalk.red('❌ Not set')}`);
    
    // Anthropic Configuration
    console.log(chalk.green('\n🤖 Anthropic Configuration:'));
    console.log(`   API Key: ${process.env.ANTHROPIC_API_KEY ? chalk.green('✅ Set') : chalk.red('❌ Not set')}`);
    
    // Application Settings
    console.log(chalk.green('\n⚙️  Application Settings:'));
    console.log(`   Max File Size: ${process.env.MAX_FILE_SIZE_MB || '100'} MB`);
    console.log(`   Default Language: ${process.env.DEFAULT_LANGUAGE || 'en'}`);
    
    // Check if configuration is complete
    const hasNeo4j = process.env.NEO4J_URL && process.env.NEO4J_USER && process.env.NEO4J_PASSWORD;
    const hasAnthropic = process.env.ANTHROPIC_API_KEY;
    
    console.log(chalk.yellow('\n🔍 Configuration Status:'));
    console.log(`   Neo4j: ${hasNeo4j ? chalk.green('✅ Ready') : chalk.red('❌ Incomplete')}`);
    console.log(`   Anthropic API: ${hasAnthropic ? chalk.green('✅ Ready') : chalk.yellow('⚠️  Optional')}`);
    
    if (hasNeo4j) {
      console.log(chalk.cyan('\n💡 Ready to use! Try: node knowledge-graph.js connect'));
    } else {
      console.log(chalk.red('\n⚠️  Please set up your Neo4j credentials in .env file'));
    }
  });

// Info command - Show help and available commands
program
  .command('info')
  .description('Show detailed information about available commands')
  .action(() => {
    console.log(chalk.blue('🏗️  Knowledge Graph CLI\n'));
    console.log('This CLI tool helps you manage a knowledge graph using Neo4j and AI integration.\n');
    
    console.log(chalk.green('📚 Available Commands:'));
    console.log('   connect     - Test connection to your Neo4j database');
    console.log('   ingest      - Process TXT files and URLs into the graph');
    console.log('   query       - Ask natural language questions');
    console.log('   interactive - Start interactive Q&A session');
    console.log('   stats       - Show graph statistics');
    console.log('   status      - Show current configuration');
    console.log('   info        - Show this help information');
    console.log('   clear       - Clear all data from the graph');
    
    console.log(chalk.yellow('\n🔧 Configuration:'));
    console.log('   Make sure you have a .env file with:');
    console.log('   - NEO4J_URL (your Neo4j connection string)');
    console.log('   - NEO4J_USER (typically "neo4j")');
    console.log('   - NEO4J_PASSWORD (your database password)');
    console.log('   - NEO4J_DATABASE (typically "neo4j")');
    console.log('   - ANTHROPIC_API_KEY (for AI features)');
    
    console.log(chalk.cyan('\n🚀 Examples:'));
    console.log('   node knowledge-graph.js connect');
    console.log('   node knowledge-graph.js ingest -f document.txt --clear');
    console.log('   node knowledge-graph.js ingest -u https://example.com/article');
    console.log('   node knowledge-graph.js query "What are the main topics?"');
    console.log('   node knowledge-graph.js interactive');
    console.log('   node knowledge-graph.js stats');
    
    console.log(chalk.magenta('\n🌐 Neo4j Browser:'));
    console.log('   Visit https://browser.neo4j.io/ to visualize your knowledge graph');
  });

// Clear command - Clear all data from the knowledge graph
program
  .command('clear')
  .description('Clear all data from the knowledge graph')
  .option('--confirm', 'Skip confirmation prompt')
  .action(async (options) => {
    if (!options.confirm) {
      const confirm = readlineSync.question(
        chalk.yellow('⚠️  This will delete ALL data from your knowledge graph. Continue? (yes/no): ')
      );
      
      if (confirm.toLowerCase() !== 'yes' && confirm.toLowerCase() !== 'y') {
        console.log(chalk.green('Operation cancelled.'));
        return;
      }
    }

    const connected = await kg.connect(
      process.env.NEO4J_URL || 'bolt://localhost:7687',
      process.env.NEO4J_USER || 'neo4j',
      process.env.NEO4J_PASSWORD || 'password',
      process.env.NEO4J_DATABASE || 'neo4j'
    );

    if (!connected) {
      console.error(chalk.red('❌ Failed to connect to Neo4j'));
      process.exit(1);
    }

    const spinner = ora('Clearing knowledge graph...').start();
    
    try {
      await session.run('MATCH (n) DETACH DELETE n');
      spinner.succeed('Knowledge graph cleared successfully');
    } catch (error) {
      spinner.fail('Failed to clear knowledge graph');
      console.error(chalk.red('Error:'), error.message);
    }
    
    await kg.close();
  });

// Parse command line arguments
program.parse();

// Handle cleanup on exit
process.on('SIGINT', async () => {
  console.log(chalk.yellow('\n\n👋 Closing connections...'));
  await kg.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await kg.close();
  process.exit(0);
});