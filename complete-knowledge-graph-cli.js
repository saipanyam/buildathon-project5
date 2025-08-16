#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');
const neo4j = require('neo4j-driver');
const axios = require('axios');
const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');

class KnowledgeGraphCLI {
  constructor() {
    this.driver = null;
    this.session = null;
    this.totalSize = 0;
    this.maxSize = (process.env.MAX_FILE_SIZE_MB || 100) * 1024 * 1024; // 100MB default
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }

  async connect(uri, username, password, database = 'neo4j') {
    try {
      console.log(chalk.blue(`🔌 Connecting to Neo4j at ${uri}...`));
      
      this.driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
      this.session = this.driver.session({ database: database });
      
      // Test connection
      const result = await this.session.run('RETURN "Connection successful" as message');
      const message = result.records[0].get('message');
      
      console.log(chalk.green(`✓ Connected to Neo4j successfully: ${message}`));
      return true;
    } catch (error) {
      console.error(chalk.red('✗ Failed to connect to Neo4j:'), error.message);
      if (error.message.includes('authentication')) {
        console.error(chalk.yellow('💡 Check your credentials in .env file'));
      }
      return false;
    }
  }

  async disconnect() {
    if (this.session) {
      await this.session.close();
    }
    if (this.driver) {
      await this.driver.close();
    }
    this.rl.close();
  }

  extractConcepts(text, fileName = '') {
    console.log(chalk.blue(`🔍 Extracting concepts from ${fileName}...`));
    
    // Enhanced concept extraction with better filtering
    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 3);
    
    // Comprehensive stop words list
    const stopWords = new Set([
      'this', 'that', 'with', 'have', 'will', 'from', 'they', 'been', 'said', 
      'each', 'which', 'their', 'time', 'about', 'would', 'there', 'could', 
      'other', 'more', 'very', 'what', 'know', 'just', 'into', 'over', 'think', 
      'also', 'your', 'work', 'life', 'only', 'can', 'still', 'should', 'after', 
      'being', 'now', 'made', 'before', 'here', 'through', 'when', 'where', 
      'how', 'all', 'any', 'may', 'say', 'get', 'has', 'had', 'his', 'her', 
      'him', 'my', 'me', 'we', 'our', 'out', 'day', 'go', 'he', 'she', 'it', 
      'of', 'to', 'and', 'a', 'in', 'is', 'it', 'you', 'that', 'he', 'was', 
      'for', 'on', 'are', 'as', 'with', 'his', 'they', 'i', 'at', 'be', 'or', 
      'an', 'were', 'by', 'but', 'not', 'do', 'can', 'if', 'no', 'had', 'my', 
      'has', 'so', 'the', 'then', 'than', 'some', 'like', 'who', 'these', 
      'those', 'such', 'many', 'most', 'much', 'while', 'since', 'both', 
      'either', 'neither', 'every', 'another', 'same', 'different', 'new', 
      'old', 'first', 'last', 'next', 'previous', 'good', 'bad', 'best', 'worst',
      'make', 'way', 'come', 'its', 'now', 'find', 'long', 'down', 'day', 'did',
      'get', 'come', 'made', 'may', 'part'
    ]);
    
    const concepts = words.filter(word => !stopWords.has(word));
    
    // Count frequency
    const frequency = {};
    concepts.forEach(concept => {
      frequency[concept] = (frequency[concept] || 0) + 1;
    });
    
    // Extract meaningful phrases (2-3 words)
    const sentences = text.split(/[.!?]+/);
    const phrases = [];
    
    sentences.forEach(sentence => {
      const words = sentence.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/);
      for (let i = 0; i < words.length - 1; i++) {
        const phrase = words.slice(i, i + 2).join(' ');
        if (phrase.length > 8 && 
            !stopWords.has(words[i]) && 
            !stopWords.has(words[i + 1]) &&
            !/^\d/.test(phrase)) {
          phrases.push(phrase);
        }
      }
    });
    
    // Count phrase frequency
    const phraseFreq = {};
    phrases.forEach(phrase => {
      phraseFreq[phrase] = (phraseFreq[phrase] || 0) + 1;
    });
    
    // Combine words and phrases, prioritize by frequency
    const singleWordConcepts = Object.entries(frequency)
      .filter(([_, count]) => count >= 2)
      .sort(([_, a], [__, b]) => b - a)
      .slice(0, 15)
      .map(([concept]) => concept);
    
    const phraseConcepts = Object.entries(phraseFreq)
      .filter(([_, count]) => count >= 2)
      .sort(([_, a], [__, b]) => b - a)
      .slice(0, 10)
      .map(([phrase]) => phrase);
    
    const allConcepts = [...singleWordConcepts, ...phraseConcepts];
    
    console.log(chalk.green(`📊 Extracted ${allConcepts.length} concepts from ${fileName}`));
    console.log(chalk.gray(`   Top concepts: ${allConcepts.slice(0, 5).join(', ')}`));
    
    return allConcepts;
  }

  async initializeDatabase() {
    const spinner = ora('Initializing database schema...').start();
    
    try {
      // Create constraints
      await this.session.run(`
        CREATE CONSTRAINT document_id IF NOT EXISTS FOR (d:Document) REQUIRE d.id IS UNIQUE
      `);
      
      await this.session.run(`
        CREATE CONSTRAINT concept_name IF NOT EXISTS FOR (c:Concept) REQUIRE c.name IS UNIQUE
      `);
      
      // Create indexes
      await this.session.run(`
        CREATE INDEX document_name IF NOT EXISTS FOR (d:Document) ON (d.name)
      `);
      
      await this.session.run(`
        CREATE INDEX concept_name_text IF NOT EXISTS FOR (c:Concept) ON (c.name)
      `);
      
      spinner.succeed('Database schema initialized');
    } catch (error) {
      spinner.fail('Failed to initialize database schema');
      console.error(chalk.red('Schema Error:'), error.message);
      throw error;
    }
  }

  async clearDatabase() {
    const spinner = ora('Clearing existing data...').start();
    
    try {
      await this.session.run('MATCH (n) DETACH DELETE n');
      spinner.succeed('Database cleared');
      this.totalSize = 0;
    } catch (error) {
      spinner.fail('Failed to clear database');
      throw error;
    }
  }

  async checkSizeLimit(newSize) {
    if (this.totalSize + newSize > this.maxSize) {
      const currentMB = (this.totalSize / 1024 / 1024).toFixed(2);
      const newMB = (newSize / 1024 / 1024).toFixed(2);
      const maxMB = (this.maxSize / 1024 / 1024).toFixed(2);
      
      console.error(chalk.red(`❌ Size limit exceeded!`));
      console.error(chalk.yellow(`   Current: ${currentMB}MB + New: ${newMB}MB > Limit: ${maxMB}MB`));
      return false;
    }
    return true;
  }

  async ingestFile(filePath) {
    try {
      console.log(chalk.blue(`📄 Processing file: ${filePath}`));
      
      // Check if file exists
      const stats = await fs.stat(filePath);
      if (!await this.checkSizeLimit(stats.size)) {
        return null;
      }
      
      const content = await fs.readFile(filePath, 'utf8');
      const fileName = path.basename(filePath);
      
      return await this.processDocument(fileName, content, 'file', filePath);
      
    } catch (error) {
      console.error(chalk.red(`✗ Error processing ${filePath}:`), error.message);
      throw error;
    }
  }

  async ingestUrl(url) {
    try {
      console.log(chalk.blue(`🌐 Fetching URL: ${url}`));
      
      const response = await axios.get(url, {
        timeout: 15000,
        maxContentLength: this.maxSize,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; KnowledgeGraph/1.0)'
        }
      });
      
      let content = response.data;
      
      // Basic HTML stripping if content is HTML
      if (content.includes('<html') || content.includes('<!DOCTYPE')) {
        content = content
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
      
      if (!await this.checkSizeLimit(content.length)) {
        return null;
      }
      
      return await this.processDocument(url, content, 'url', url);
      
    } catch (error) {
      console.error(chalk.red(`✗ Error processing ${url}:`), error.message);
      throw error;
    }
  }

  async processDocument(name, content, type, source) {
    const concepts = this.extractConcepts(content, name);
    const docId = `${type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const spinner = ora(`Storing ${name} in Neo4j...`).start();
    
    try {
      // Create document node
      await this.session.run(`
        CREATE (d:Document {
          id: $docId,
          name: $name,
          content: $content,
          source: $source,
          type: $type,
          createdAt: datetime(),
          size: $size
        })
      `, {
        docId,
        name,
        content,
        source,
        type,
        size: content.length
      });
      
      // Create concept nodes and document relationships
      for (const concept of concepts) {
        await this.session.run(`
          MERGE (c:Concept {name: $concept})
          ON CREATE SET c.createdAt = datetime(), c.frequency = 1
          ON MATCH SET c.frequency = c.frequency + 1
          WITH c
          MATCH (d:Document {id: $docId})
          CREATE (d)-[:CONTAINS {weight: 1}]->(c)
        `, { concept, docId });
      }
      
      // Create concept co-occurrence relationships
      for (let i = 0; i < concepts.length; i++) {
        for (let j = i + 1; j < concepts.length; j++) {
          await this.session.run(`
            MATCH (c1:Concept {name: $concept1})
            MATCH (c2:Concept {name: $concept2})
            MERGE (c1)-[r:RELATED_TO]-(c2)
            ON CREATE SET r.weight = 1, r.createdAt = datetime()
            ON MATCH SET r.weight = r.weight + 1
          `, { concept1: concepts[i], concept2: concepts[j] });
        }
      }
      
      this.totalSize += content.length;
      
      spinner.succeed(`Stored ${name} with ${concepts.length} concepts`);
      
      return { 
        name, 
        concepts: concepts.length, 
        size: content.length,
        type 
      };
      
    } catch (error) {
      spinner.fail(`Failed to store ${name}`);
      console.error(chalk.red('Storage Error:'), error.message);
      throw error;
    }
  }

  async queryGraph(question) {
    try {
      console.log(chalk.blue(`🔍 Searching knowledge graph for: "${question}"`));
      
      const queryWords = question.toLowerCase().split(/\s+/)
        .filter(word => word.length > 2);
      
      // Find relevant concepts using fuzzy matching
      const conceptQuery = `
        MATCH (c:Concept)
        WHERE ANY(word IN $words WHERE c.name CONTAINS word)
           OR ANY(word IN $words WHERE word CONTAINS c.name)
        RETURN c.name as concept, c.frequency as frequency
        ORDER BY c.frequency DESC
        LIMIT 15
      `;
      
      const conceptResult = await this.session.run(conceptQuery, { words: queryWords });
      const relevantConcepts = conceptResult.records.map(record => ({
        name: record.get('concept'),
        frequency: record.get('frequency').toNumber()
      }));
      
      if (relevantConcepts.length === 0) {
        return {
          answer: "I couldn't find any relevant concepts in the knowledge graph for your question.",
          concepts: [],
          documents: []
        };
      }
      
      console.log(chalk.gray(`   Found ${relevantConcepts.length} relevant concepts`));
      
      // Find documents containing these concepts
      const docQuery = `
        MATCH (d:Document)-[:CONTAINS]->(c:Concept)
        WHERE c.name IN $concepts
        WITH d, COUNT(c) as conceptCount, COLLECT(c.name) as matchedConcepts
        ORDER BY conceptCount DESC
        LIMIT 5
        RETURN d.name as name, d.content as content, d.type as type, 
               conceptCount, matchedConcepts
      `;
      
      const conceptNames = relevantConcepts.map(c => c.name);
      const docResult = await this.session.run(docQuery, { concepts: conceptNames });
      
      if (docResult.records.length === 0) {
        return {
          answer: "No documents found containing the relevant concepts.",
          concepts: relevantConcepts,
          documents: []
        };
      }
      
      // Extract the most relevant answer
      let bestAnswer = '';
      let bestScore = 0;
      const relevantDocs = [];
      
      docResult.records.forEach(record => {
        const docName = record.get('name');
        const content = record.get('content');
        const docType = record.get('type');
        const conceptCount = record.get('conceptCount').toNumber();
        const matchedConcepts = record.get('matchedConcepts');
        
        relevantDocs.push({ name: docName, type: docType, concepts: matchedConcepts });
        
        // Split content into sentences and score them
        const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 20);
        
        sentences.forEach(sentence => {
          const sentenceLower = sentence.toLowerCase();
          let score = 0;
          
          // Score based on query words
          queryWords.forEach(word => {
            if (sentenceLower.includes(word)) score += 2;
          });
          
          // Score based on relevant concepts
          relevantConcepts.forEach(concept => {
            if (sentenceLower.includes(concept.name)) score += 1;
          });
          
          // Bonus for sentences with multiple matches
          if (score > 2) score *= 1.5;
          
          if (score > bestScore && sentence.trim().length > 30) {
            bestScore = score;
            bestAnswer = sentence.trim();
          }
        });
      });
      
      // Format the response
      const conceptsList = relevantConcepts.slice(0, 5).map(c => c.name).join(', ');
      
      let finalAnswer;
      if (bestAnswer) {
        finalAnswer = `Based on your documents: ${bestAnswer}`;
      } else {
        finalAnswer = `Found relevant concepts (${conceptsList}) but couldn't extract a specific answer. Try rephrasing your question.`;
      }
      
      return {
        answer: finalAnswer,
        concepts: relevantConcepts,
        documents: relevantDocs
      };
      
    } catch (error) {
      console.error(chalk.red('Query Error:'), error.message);
      return {
        answer: "Error occurred while searching the knowledge graph.",
        concepts: [],
        documents: []
      };
    }
  }

  async getGraphStats() {
    try {
      const statsQuery = `
        MATCH (d:Document) 
        OPTIONAL MATCH (c:Concept)
        OPTIONAL MATCH (r:RELATED_TO)
        RETURN 
          COUNT(DISTINCT d) as documents,
          COUNT(DISTINCT c) as concepts,
          COUNT(DISTINCT r) as relationships
      `;
      
      const result = await this.session.run(statsQuery);
      const record = result.records[0];
      
      // Get size info
      const sizeQuery = `
        MATCH (d:Document)
        RETURN SUM(d.size) as totalSize, AVG(d.size) as avgSize
      `;
      
      const sizeResult = await this.session.run(sizeQuery);
      const sizeRecord = sizeResult.records[0];
      
      return {
        documents: record.get('documents').toNumber(),
        concepts: record.get('concepts').toNumber(),
        relationships: record.get('relationships').toNumber(),
        totalSize: sizeRecord.get('totalSize') ? sizeRecord.get('totalSize').toNumber() : 0,
        avgSize: sizeRecord.get('avgSize') ? sizeRecord.get('avgSize').toNumber() : 0
      };
    } catch (error) {
      console.error('Error getting stats:', error.message);
      return { documents: 0, concepts: 0, relationships: 0, totalSize: 0, avgSize: 0 };
    }
  }

  async interactiveMode() {
    console.log(chalk.cyan('\n🧠 Knowledge Graph Interactive Mode'));
    console.log(chalk.gray('Commands: "exit" to quit, "stats" for statistics, "help" for help\n'));

    const askQuestion = () => {
      this.rl.question(chalk.yellow('❓ Ask a question: '), async (input) => {
        const command = input.toLowerCase().trim();
        
        if (command === 'exit') {
          await this.disconnect();
          process.exit(0);
        }
        
        if (command === 'stats') {
          const stats = await this.getGraphStats();
          console.log(chalk.blue(`\n📊 Knowledge Graph Statistics:`));
          console.log(chalk.white(`   Documents: ${stats.documents}`));
          console.log(chalk.white(`   Concepts: ${stats.concepts}`));
          console.log(chalk.white(`   Relationships: ${stats.relationships}`));
          console.log(chalk.white(`   Total Size: ${(stats.totalSize / 1024).toFixed(2)} KB`));
          console.log(chalk.white(`   Average Document Size: ${(stats.avgSize / 1024).toFixed(2)} KB\n`));
        } else if (command === 'help') {
          console.log(chalk.blue('\n📖 Available Commands:'));
          console.log(chalk.white('   exit     - Exit interactive mode'));
          console.log(chalk.white('   stats    - Show graph statistics'));
          console.log(chalk.white('   help     - Show this help message'));
          console.log(chalk.white('   Or ask any question about your documents!\n'));
        } else if (input.trim()) {
          const spinner = ora('Searching knowledge graph...').start();
          const result = await this.queryGraph(input);
          spinner.stop();
          
          console.log(chalk.green(`\n💡 ${result.answer}`));
          
          if (result.concepts.length > 0) {
            console.log(chalk.gray(`🔍 Related concepts: ${result.concepts.slice(0, 3).map(c => c.name).join(', ')}`));
          }
          
          if (result.documents.length > 0) {
            console.log(chalk.gray(`📄 Sources: ${result.documents.slice(0, 2).map(d => d.name).join(', ')}`));
          }
          console.log('');
        }
        
        askQuestion();
      });
    };

    askQuestion();
  }
}

// CLI Setup
const program = new Command();
const kg = new KnowledgeGraphCLI();

program
  .name('knowledge-graph')
  .description('Knowledge Graph CLI with Neo4j integration')
  .version('1.0.0');

program
  .command('connect')
  .description('Connect to Neo4j database')
  .option('-u, --uri <uri>', 'Neo4j URI', process.env.NEO4J_URL || 'bolt://localhost:7687')
  .option('--username <username>', 'Username', process.env.NEO4J_USER || 'neo4j')
  .option('--password <password>', 'Password', process.env.NEO4J_PASSWORD || 'password')
  .option('-d, --database <database>', 'Database name', process.env.NEO4J_DATABASE || 'neo4j')
  .action(async (options) => {
    const connected = await kg.connect(options.uri, options.username, options.password, options.database);
    if (connected) {
      await kg.initializeDatabase();
    }
  });

program
  .command('ingest')
  .description('Ingest documents into the knowledge graph')
  .option('-f, --file <files...>', 'TXT files to ingest')
  .option('-u, --url <urls...>', 'URLs to ingest')
  .option('--clear', 'Clear existing data first')
  .action(async (options) => {
    if (!kg.driver) {
      console.log(chalk.red('❌ Please connect to Neo4j first: node knowledge-graph.js connect'));
      return;
    }

    if (options.clear) {
      await kg.clearDatabase();
    }

    const results = [];
    let hasErrors = false;

    if (options.file) {
      for (const file of options.file) {
        try {
          const result = await kg.ingestFile(file);
          if (result) results.push(result);
        } catch (error) {
          hasErrors = true;
        }
      }
    }

    if (options.url) {
      for (const url of options.url) {
        try {
          const result = await kg.ingestUrl(url);
          if (result) results.push(result);
        } catch (error) {
          hasErrors = true;
        }
      }
    }

    console.log(chalk.green(`\n✅ Ingestion complete! Processed ${results.length} sources.`));
    
    const stats = await kg.getGraphStats();
    console.log(chalk.blue(`📊 Graph now contains:`));
    console.log(chalk.white(`   📄 ${stats.documents} documents`));
    console.log(chalk.white(`   🧠 ${stats.concepts} concepts`));
    console.log(chalk.white(`   🔗 ${stats.relationships} relationships`));
    console.log(chalk.white(`   💾 ${(stats.totalSize / 1024).toFixed(2)} KB total`));
    
    if (hasErrors) {
      console.log(chalk.yellow('\n⚠️  Some files had errors. Check the logs above.'));
    }
  });

program
  .command('query <question>')
  .description('Query the knowledge graph')
  .action(async (question) => {
    if (!kg.driver) {
      console.log(chalk.red('❌ Please connect to Neo4j first: node knowledge-graph.js connect'));
      return;
    }

    const spinner = ora('Searching knowledge graph...').start();
    const result = await kg.queryGraph(question);
    spinner.succeed('Search complete');
    
    console.log(chalk.green(`\n💡 ${result.answer}`));
    
    if (result.concepts.length > 0) {
      console.log(chalk.blue(`\n🔍 Related concepts found: ${result.concepts.length}`));
      result.concepts.slice(0, 5).forEach(concept => {
        console.log(chalk.gray(`   • ${concept.name} (frequency: ${concept.frequency})`));
      });
    }
    
    if (result.documents.length > 0) {
      console.log(chalk.blue(`\n📄 Relevant documents: ${result.documents.length}`));
      result.documents.forEach(doc => {
        console.log(chalk.gray(`   • ${doc.name} (${doc.type}) - concepts: ${doc.concepts.slice(0, 3).join(', ')}`));
      });
    }
  });

program
  .command('interactive')
  .description('Start interactive Q&A mode')
  .action(async () => {
    if (!kg.driver) {
      console.log(chalk.red('❌ Please connect to Neo4j first: node knowledge-graph.js connect'));
      return;
    }

    await kg.interactiveMode();
  });

program
  .command('stats')
  .description('Show graph statistics')
  .action(async () => {
    if (!kg.driver) {
      console.log(chalk.red('❌ Please connect to Neo4j first: node knowledge-graph.js connect'));
      return;
    }

    const stats = await kg.getGraphStats();
    console.log(chalk.blue(`\n📊 Knowledge Graph Statistics:`));
    console.log(chalk.white(`   📄 Documents: ${stats.documents}`));
    console.log(chalk.white(`   🧠 Concepts: ${stats.concepts}`));
    console.log(chalk.white(`   🔗 Relationships: ${stats.relationships}`));
    console.log(chalk.white(`   💾 Total Size: ${(stats.totalSize / 1024).toFixed(2)} KB`));
    console.log(chalk.white(`   📏 Average Document: ${(stats.avgSize / 1024).toFixed(2)} KB`));
    
    if (stats.totalSize > 0) {
      const percentUsed = ((stats.totalSize / (100 * 1024 * 1024)) * 100).toFixed(1);
      console.log(chalk.white(`   📈 Storage Used: ${percentUsed}% of 100MB limit`));
    }
  });

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log(chalk.yellow('\n\n👋 Shutting down gracefully...'));
  await kg.disconnect();
  process.exit(0);
});

program.parse();