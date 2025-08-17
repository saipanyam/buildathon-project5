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
      await session.run('CREATE CONSTRAINT entity_name IF NOT EXISTS FOR (e:Entity) REQUIRE e.name IS UNIQUE');
      await session.run('CREATE INDEX doc_name IF NOT EXISTS FOR (d:Document) ON (d.name)');
      await session.run('CREATE INDEX concept_freq IF NOT EXISTS FOR (c:Concept) ON (c.frequency)');
      await session.run('CREATE INDEX entity_type IF NOT EXISTS FOR (e:Entity) ON (e.type)');
      await session.run('CREATE INDEX entity_freq IF NOT EXISTS FOR (e:Entity) ON (e.frequency)');
      
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

  async extractEntitiesWithLLM(text) {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log('⚠️  No Anthropic API key found, using basic extraction');
      return this.extractConcepts(text);
    }

    try {
      const prompt = `Extract entities and their relationships from this text. Return a JSON object with:
{
  "entities": [{"name": "entity name", "type": "PERSON|ORGANIZATION|CONCEPT|TECHNOLOGY|LOCATION", "description": "brief description"}],
  "relationships": [{"source": "entity1", "target": "entity2", "type": "RELATED_TO|WORKS_AT|PART_OF|USES", "description": "relationship description"}]
}

Text: ${text.substring(0, 2000)}`;

      const response = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-3-haiku-20240307',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      }, {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        }
      });

      const result = JSON.parse(response.data.content[0].text);
      return result;
    } catch (error) {
      console.log('⚠️  LLM extraction failed, falling back to basic extraction:', error.message);
      return { entities: await this.extractConcepts(text), relationships: [] };
    }
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

      // Enhanced entity extraction with LLM
      spinner.text = 'Extracting entities and relationships...';
      const extracted = await this.extractEntitiesWithLLM(content);
      
      // Create document node
      const docId = path.basename(filePath) + '_' + Date.now();
      await session.run(
        'CREATE (d:Document {id: $id, name: $name, content: $content, type: "file", size: $size, createdAt: datetime()})'
        , { id: docId, name: path.basename(filePath), content: content.substring(0, 1000), size: stats.size }
      );

      // Create entity nodes and relationships
      const entities = extracted.entities || extracted;
      for (const entity of entities) {
        const entityData = {
          name: entity.name,
          type: entity.type || 'CONCEPT',
          description: entity.description || '',
          frequency: entity.frequency || 1
        };
        
        await session.run(
          `MERGE (e:Entity {name: $name})
           ON CREATE SET e.type = $type, e.description = $description, e.frequency = $frequency, e.createdAt = datetime()
           ON MATCH SET e.frequency = e.frequency + $frequency`,
          entityData
        );
        
        await session.run(
          'MATCH (d:Document {id: $docId}), (e:Entity {name: $entityName}) CREATE (d)-[:CONTAINS {frequency: $frequency}]->(e)',
          { docId, entityName: entity.name, frequency: entity.frequency || 1 }
        );
      }

      // Create entity relationships
      if (extracted.relationships) {
        await this.createEntityRelationships(extracted.relationships, docId);
      }

      // Create concept relationships based on co-occurrence (fallback)
      if (!extracted.relationships || extracted.relationships.length === 0) {
        await this.createConceptRelationships(entities);
      }

      spinner.succeed(`Successfully processed: ${path.basename(filePath)} (${entities.length} entities extracted)`);
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

  async createEntityRelationships(relationships, docId) {
    // Create LLM-extracted relationships between entities
    for (const rel of relationships) {
      try {
        await session.run(
          `MATCH (e1:Entity {name: $source}), (e2:Entity {name: $target})
           MERGE (e1)-[r:${rel.type || 'RELATED_TO'}]->(e2)
           ON CREATE SET r.description = $description, r.confidence = 1.0, r.docId = $docId
           ON MATCH SET r.confidence = r.confidence + 0.1`,
          { 
            source: rel.source, 
            target: rel.target, 
            description: rel.description || '',
            docId 
          }
        );
      } catch (error) {
        // Skip invalid relationships
        console.log(`⚠️  Skipped relationship: ${rel.source} -> ${rel.target}`);
      }
    }
  }

  async detectCommunities() {
    // Basic community detection using connected components
    try {
      const result = await session.run(`
        CALL gds.graph.project('entity-graph', 'Entity', '*') YIELD graphName
        CALL gds.wcc.write('entity-graph', { writeProperty: 'community' })
        YIELD nodePropertiesWritten, componentCount
        CALL gds.graph.drop('entity-graph')
        RETURN componentCount as communities, nodePropertiesWritten as nodes
      `);
      
      return result.records[0]?.get('communities')?.toNumber() || 0;
    } catch (error) {
      // Fallback: simple clustering based on entity types
      await session.run(`
        MATCH (e:Entity)
        SET e.community = CASE 
          WHEN e.type = 'PERSON' THEN 'people'
          WHEN e.type = 'ORGANIZATION' THEN 'organizations'
          WHEN e.type = 'TECHNOLOGY' THEN 'technologies'
          WHEN e.type = 'LOCATION' THEN 'locations'
          ELSE 'concepts'
        END
      `);
      
      const result = await session.run('MATCH (e:Entity) RETURN DISTINCT e.community as community');
      return result.records.length;
    }
  }

  async queryGraph(question, mode = 'auto') {
    try {
      // Determine search mode automatically if not specified
      if (mode === 'auto') {
        mode = this.determineSearchMode(question);
      }

      if (mode === 'global') {
        return await this.globalSearch(question);
      } else {
        return await this.localSearch(question);
      }
    } catch (error) {
      console.error('Query error:', error);
      return `Error processing question: ${error.message}`;
    }
  }

  determineSearchMode(question) {
    // Global search for broad, analytical questions
    const globalIndicators = ['overall', 'general', 'compare', 'analyze', 'overview', 'summary', 'trend', 'pattern'];
    const localIndicators = ['specific', 'detail', 'who', 'what', 'when', 'where', 'how'];
    
    const lowerQuestion = question.toLowerCase();
    const globalScore = globalIndicators.filter(indicator => lowerQuestion.includes(indicator)).length;
    const localScore = localIndicators.filter(indicator => lowerQuestion.includes(indicator)).length;
    
    return globalScore > localScore ? 'global' : 'local';
  }

  async globalSearch(question) {
    // Global search: reasoning about corpus-wide patterns
    try {
      // Get community summaries
      const communitiesQuery = `
        MATCH (e:Entity)
        WHERE e.community IS NOT NULL
        WITH e.community as community, COLLECT(e) as entities
        RETURN community, SIZE(entities) as size, 
               [entity IN entities | entity.name][0..5] as sampleEntities
        ORDER BY size DESC
        LIMIT 10
      `;
      
      const communitiesResult = await session.run(communitiesQuery);
      const communities = communitiesResult.records.map(record => ({
        name: record.get('community'),
        size: record.get('size').toNumber(),
        entities: record.get('sampleEntities')
      }));

      // Use LLM to generate global insights
      if (process.env.ANTHROPIC_API_KEY && communities.length > 0) {
        const prompt = `Based on the knowledge graph communities below, answer this question: "${question}"

Communities in the knowledge graph:
${communities.map(c => `- ${c.name}: ${c.size} entities (examples: ${c.entities.join(', ')})`).join('\n')}

Provide a comprehensive answer based on patterns across the entire dataset.`;

        const response = await axios.post('https://api.anthropic.com/v1/messages', {
          model: 'claude-3-haiku-20240307',
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }]
        }, {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          }
        });

        return response.data.content[0].text;
      }

      return `Global overview: Found ${communities.length} communities in the knowledge graph:\n` +
             communities.map(c => `• ${c.name}: ${c.size} entities`).join('\n');
    } catch (error) {
      return `Global search error: ${error.message}`;
    }
  }

  async localSearch(question) {
    // Local search: exploring specific entity contexts
    try {
      // Extract key terms from question
      const questionTokens = this.tokenizer.tokenize(question.toLowerCase());
      const keyTerms = questionTokens
        .filter(token => !natural.stopwords.includes(token) && token.length > 2)
        .map(token => this.stemmer.stem(token));

      if (keyTerms.length === 0) {
        return 'Please provide a more specific question with meaningful terms.';
      }

      // Find relevant entities (enhanced from old concept search)
      const entityQuery = `
        MATCH (e:Entity)
        WHERE ANY(term IN $terms WHERE e.name CONTAINS term OR e.description CONTAINS term)
        OPTIONAL MATCH (e)-[r]-(connected:Entity)
        WITH e, COLLECT(DISTINCT connected.name)[0..5] as connectedEntities
        RETURN e.name as entity, e.type as type, e.description as description, e.frequency as frequency,
               connectedEntities
        ORDER BY frequency DESC
        LIMIT 10
      `;
      
      const entityResult = await session.run(entityQuery, { terms: keyTerms });
      const relevantEntities = entityResult.records.map(record => ({
        name: record.get('entity'),
        type: record.get('type'),
        description: record.get('description'),
        connected: record.get('connectedEntities')
      }));

      // Fallback to concepts if no entities found
      if (relevantEntities.length === 0) {
        console.log('🔄 No entities found, falling back to concept search...');
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
          type: 'CONCEPT',
          description: '',
          connected: [],
          frequency: record.get('frequency')
        }));
        
        if (relevantConcepts.length === 0) {
          return 'No relevant concepts or entities found in the knowledge graph for your question.';
        }
        
        // Use concepts as entities for the rest of the process
        for (const concept of relevantConcepts) {
          relevantEntities.push(concept);
        }
      }

      // Find documents containing these entities/concepts
      const docQuery = `
        MATCH (d:Document)-[r:CONTAINS]->(n)
        WHERE (n:Entity OR n:Concept) AND n.name IN $entities
        RETURN d.name as document, d.content as content, d.type as type, 
               COLLECT(n.name) as entities, SUM(r.frequency) as relevance
        ORDER BY relevance DESC
        LIMIT 5
      `;
      
      const docResult = await session.run(docQuery, { 
        entities: relevantEntities.map(e => e.name) 
      });
      
      const relevantDocs = docResult.records.map(record => {
        const relevanceValue = record.get('relevance');
        return {
          name: record.get('document'),
          content: record.get('content'),
          type: record.get('type'),
          entities: record.get('entities'),
          relevance: neo4j.isInt(relevanceValue) ? relevanceValue.toNumber() : (relevanceValue || 0)
        };
      });

      // Build response
      let response = `Based on your question about "${question}", here's what I found:\n\n`;
      
      response += `🔍 **Relevant Entities:**\n`;
      relevantEntities.slice(0, 5).forEach(entity => {
        response += `   • ${entity.name} (${entity.type})${entity.description ? ': ' + entity.description : ''}\n`;
        if (entity.connected && entity.connected.length > 0) {
          response += `     Connected to: ${entity.connected.slice(0, 3).join(', ')}\n`;
        }
      });
      
      response += `\n📄 **Related Documents:**\n`;
      relevantDocs.forEach((doc, index) => {
        response += `   ${index + 1}. ${doc.name} (${doc.type})\n`;
        response += `      Preview: ${doc.content.substring(0, 200)}...\n`;
        response += `      Key entities: ${doc.entities.slice(0, 3).join(', ')}\n\n`;
      });

      return response;

    } catch (error) {
      return `Local search error: ${error.message}`;
    }
  }

  async getStats() {
    try {
      const stats = {};
      
      // Count documents
      const docResult = await session.run('MATCH (d:Document) RETURN COUNT(d) as count');
      stats.documents = docResult.records[0].get('count').toNumber();
      
      // Count concepts (legacy)
      const conceptResult = await session.run('MATCH (c:Concept) RETURN COUNT(c) as count');
      stats.concepts = conceptResult.records[0].get('count').toNumber();
      
      // Count entities (enhanced)
      const entityResult = await session.run('MATCH (e:Entity) RETURN COUNT(e) as count');
      stats.entities = entityResult.records[0].get('count').toNumber();
      
      // Count relationships
      const relResult = await session.run('MATCH ()-[r]-() RETURN COUNT(r) as count');
      stats.relationships = relResult.records[0].get('count').toNumber();
      
      // Count communities
      const communityResult = await session.run('MATCH (e:Entity) WHERE e.community IS NOT NULL RETURN COUNT(DISTINCT e.community) as count');
      stats.communities = communityResult.records[0]?.get('count')?.toNumber() || 0;
      
      // Top entities by type
      const typeResult = await session.run('MATCH (e:Entity) RETURN e.type as type, COUNT(e) as count ORDER BY count DESC');
      stats.entityTypes = typeResult.records.map(record => ({
        type: record.get('type'),
        count: record.get('count').toNumber()
      }));
      
      // Top entities
      const topEntityResult = await session.run(
        'MATCH (e:Entity) RETURN e.name as name, e.type as type, e.frequency as frequency ORDER BY e.frequency DESC LIMIT 10'
      );
      stats.topEntities = topEntityResult.records.map(record => ({
        name: record.get('name'),
        type: record.get('type'),
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
  .description('🤔 Ask a natural language question about the knowledge graph')
  .option('-m, --mode <mode>', 'Search mode: auto, global, local', 'auto')
  .action(async (question, options) => {
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

    const mode = options.mode;
    console.log(chalk.blue(`🤔 Processing question: "${question}"`));
    console.log(chalk.gray(`🔍 Search mode: ${mode}\n`));
    
    const answer = await kg.queryGraph(question, mode);
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
      
      if (stats.topEntities && stats.topEntities.length > 0) {
        console.log(chalk.blue('\n🔥 Top Entities:'));
        stats.topEntities.forEach((entity, index) => {
          console.log(chalk.cyan(`   ${index + 1}. ${entity.name} (${entity.type}) - frequency: ${entity.frequency}`));
        });
      }
      
      if (stats.entityTypes && stats.entityTypes.length > 0) {
        console.log(chalk.blue('\n📊 Entity Types:'));
        stats.entityTypes.forEach(type => {
          console.log(chalk.cyan(`   • ${type.type}: ${type.count} entities`));
        });
      }
      
      if (stats.communities > 0) {
        console.log(chalk.blue(`\n🏘️  Communities: ${stats.communities}`));
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

// Communities command - Detect and analyze communities
program
  .command('communities')
  .description('🏘️  Detect communities in the knowledge graph')
  .action(async () => {
    console.log(chalk.blue('🏘️  Knowledge Graph Communities\n'));
    
    const kg = new KnowledgeGraph();
    
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
      const communityCount = await kg.detectCommunities();
      console.log(chalk.green(`✅ Detected ${communityCount} communities`));
      
      // Show community details
      const communitiesQuery = `
        MATCH (e:Entity)
        WHERE e.community IS NOT NULL
        WITH e.community as community, COLLECT(e.name) as entities, COLLECT(e.type) as types
        RETURN community, SIZE(entities) as size, entities[0..5] as sampleEntities, 
               apoc.coll.frequencies(types) as typeDistribution
        ORDER BY size DESC
      `;
      
      try {
        const result = await session.run(communitiesQuery);
        result.records.forEach((record, index) => {
          const community = record.get('community');
          const size = record.get('size').toNumber();
          const samples = record.get('sampleEntities');
          console.log(chalk.cyan(`\n${index + 1}. Community: ${community} (${size} entities)`));
          console.log(chalk.white(`   Sample entities: ${samples.join(', ')}`));
        });
      } catch (error) {
        // Fallback for systems without APOC
        const simpleQuery = `
          MATCH (e:Entity)
          WHERE e.community IS NOT NULL
          WITH e.community as community, COLLECT(e.name) as entities
          RETURN community, SIZE(entities) as size, entities[0..5] as sampleEntities
          ORDER BY size DESC
        `;
        const result = await session.run(simpleQuery);
        result.records.forEach((record, index) => {
          const community = record.get('community');
          const size = record.get('size').toNumber();
          const samples = record.get('sampleEntities');
          console.log(chalk.cyan(`\n${index + 1}. Community: ${community} (${size} entities)`));
          console.log(chalk.white(`   Sample entities: ${samples.join(', ')}`));
        });
      }
      
    } catch (error) {
      console.error(chalk.red('❌ Failed to detect communities:'), error.message);
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