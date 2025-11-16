
import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { GoogleGenAI } from "@google/genai";

// --- TYPES ---
type PriceData = {
  date: string;
  close: number;
};

type StockData = {
  companyName: string;
  exchange: string;
  latestPrice: number;
  news: { title: string; source: string; }[];
  ratings: string[];
  prices: PriceData[];
  sentimentSummary: string;
  earningsDate: string;
};

type Signal = 'up' | 'down' | 'neutral';

type SignalResult = {
  signal: Signal;
  symbol: string;
  companyName: string;
  exchange: string;
  crossoverPrice: number;
  latestPrice: number;
  distancePercent: number;
  news: { title: string; source: string; }[];
  ratings: string[];
  sentimentSummary: string;
  earningsDate: string;
  // Data for chart
  prices: number[];
  smaShort: (number | null)[];
  smaLong: (number | null)[];
  crossoverIndex: number;
  shortPeriod: number;
  longPeriod: number;
};

// --- API & DATA LOGIC ---

const getStockData = async (symbol: string, apiKey: string): Promise<StockData | null> => {
    const ai = new GoogleGenAI({ apiKey });
    try {
        const prompt = `
For the US stock ticker "${symbol}", provide the following information in a single JSON object.
1.  Use Google Search to find the most up-to-date, real information for the company name, primary exchange, and latest stock price.
2.  Use Google Search to find 2-3 recent news headlines (with source) and 2-3 recent analyst rating changes (upgrades/downgrades).
3.  Use Google Search to analyze public sentiment over the last 2 weeks from sources like X.com or public forums. Provide a brief, one-sentence summary (e.g., "Sentiment is generally positive due to recent earnings reports.").
4.  Use Google Search to find the next upcoming earnings release date, including whether it is pre-market (AM) or post-market (PM). If not available, return an empty string.
5.  Generate a list of simulated daily closing prices for the last 40 trading days to be used for technical analysis.

The final JSON object must have this exact structure:
{
  "companyName": "...",
  "exchange": "...",
  "latestPrice": 123.45,
  "news": [
    { "title": "...", "source": "..." }
  ],
  "ratings": [
    "Analyst X upgraded to Buy.",
    "..."
  ],
  "sentimentSummary": "...",
  "earningsDate": "YYYY-MM-DD (AM/PM)",
  "prices": [
    { "date": "YYYY-MM-DD", "close": 120.00 },
    ... 39 more entries
  ]
}
`;
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
                tools: [{ googleSearch: {} }],
            },
        });
        
        let jsonText = response.text.trim();
        if (jsonText.startsWith('```json')) {
            jsonText = jsonText.substring(7, jsonText.length - 3).trim();
        } else if (jsonText.startsWith('```')) {
             jsonText = jsonText.substring(3, jsonText.length - 3).trim();
        }

        const data = JSON.parse(jsonText) as StockData;
        
        if (data.prices.length < 20) {
          throw new Error("Not enough historical data to calculate indicators.");
        }
      
        return data;

    } catch (error) {
        console.error("Error fetching or parsing stock data:", error);
        if (error instanceof Error && (error.message.includes("JSON") || error.message.includes("Unexpected token"))) {
          throw new Error(`Could not get reliable data for symbol "${symbol}". The symbol might be incorrect or the data format was unexpected.`);
        }
        throw new Error('An error occurred while fetching grounded data.');
    }
};


const calculateSMA = (data: number[], period: number): (number | null)[] => {
    if (period <= 0) return Array(data.length).fill(null);
    return data.map((_, index, arr) => {
        if (index < period - 1) {
            return null;
        }
        const chunk = arr.slice(index - period + 1, index + 1);
        const sum = chunk.reduce((acc, val) => acc + val, 0);
        return sum / period;
    });
};

const analyzeData = (symbol: string, data: StockData, shortPeriod: number, longPeriod: number): SignalResult => {
    const prices = data.prices.map(p => p.close).reverse(); // Oldest to newest

    const smaShort = calculateSMA(prices, shortPeriod);
    const smaLong = calculateSMA(prices, longPeriod);

    let lastCrossover = {
        type: 'neutral' as Signal,
        index: -1
    };
    
    // Start from where the longer SMA is valid
    for (let i = longPeriod; i < prices.length; i++) { 
        const prevShort = smaShort[i - 1];
        const prevLong = smaLong[i - 1];
        const currShort = smaShort[i];
        const currLong = smaLong[i];

        if (prevShort !== null && prevLong !== null && currShort !== null && currLong !== null) {
            if (prevShort <= prevLong && currShort > currLong) {
                lastCrossover = { type: 'up', index: i };
            }
            if (prevShort >= prevLong && currShort < currLong) {
                lastCrossover = { type: 'down', index: i };
            }
        }
    }
    
    const latestPrice = data.latestPrice;

    if (lastCrossover.index === -1) {
        return {
            signal: 'neutral',
            symbol,
            companyName: data.companyName,
            exchange: data.exchange,
            crossoverPrice: 0,
            latestPrice,
            distancePercent: 0,
            news: data.news,
            ratings: data.ratings,
            sentimentSummary: data.sentimentSummary,
            earningsDate: data.earningsDate,
            prices,
            smaShort,
            smaLong,
            crossoverIndex: -1,
            shortPeriod,
            longPeriod,
        };
    }

    const crossoverPrice = prices[lastCrossover.index];
    let currentSignal = lastCrossover.type;

    if (currentSignal === 'up' && latestPrice < crossoverPrice) {
        currentSignal = 'neutral';
    } else if (currentSignal === 'down' && latestPrice > crossoverPrice) {
        currentSignal = 'neutral';
    }

    const distancePercent = ((latestPrice - crossoverPrice) / crossoverPrice) * 100;

    return {
        signal: currentSignal,
        symbol: symbol.toUpperCase(),
        companyName: data.companyName,
        exchange: data.exchange,
        crossoverPrice,
        latestPrice,
        distancePercent,
        news: data.news,
        ratings: data.ratings,
        sentimentSummary: data.sentimentSummary,
        earningsDate: data.earningsDate,
        prices,
        smaShort,
        smaLong,
        crossoverIndex: lastCrossover.index,
        shortPeriod,
        longPeriod,
    };
};

// --- UI COMPONENTS ---

const Chart = ({ prices, smaShort, smaLong, crossoverIndex, shortPeriod, longPeriod }: { prices: number[], smaShort: (number|null)[], smaLong: (number|null)[], crossoverIndex: number, shortPeriod: number, longPeriod: number }) => {
    const width = 500;
    const height = 250;
    const padding = 20;

    const validPrices = prices.filter(p => p !== null && p !== undefined);
    if (validPrices.length === 0) return null;
    
    const minPrice = Math.min(...validPrices);
    const maxPrice = Math.max(...validPrices);
    const priceRange = maxPrice - minPrice === 0 ? 1 : maxPrice - minPrice;

    const xScale = (index: number) => (index / (prices.length - 1)) * (width - 2 * padding) + padding;
    const yScale = (price: number) => height - padding - ((price - minPrice) / priceRange) * (height - 2 * padding);

    const createPath = (data: (number | null)[]) => {
        let pathD = '';
        let firstPoint = true;
        data.forEach((d, i) => {
            if (d !== null) {
                const x = xScale(i);
                const y = yScale(d);
                if (firstPoint) {
                    pathD += `M ${x.toFixed(2)},${y.toFixed(2)}`;
                    firstPoint = false;
                } else {
                    pathD += ` L ${x.toFixed(2)},${y.toFixed(2)}`;
                }
            }
        });
        return pathD;
    };
    
    const pricePath = createPath(prices);
    const smaShortPath = createPath(smaShort);
    const smaLongPath = createPath(smaLong);

    const crossoverX = crossoverIndex > -1 ? xScale(crossoverIndex) : null;
    const crossoverY = crossoverIndex > -1 && prices[crossoverIndex] !== null ? yScale(prices[crossoverIndex]) : null;
    
    const legendColorBox = (color: string): React.CSSProperties => ({
        width: '12px',
        height: '12px',
        backgroundColor: color,
        borderRadius: '2px'
    });

    const styles: { [key: string]: React.CSSProperties } = {
        chartContainer: {
            marginTop: '2rem',
            position: 'relative'
        },
        svg: {
            width: '100%',
            height: 'auto',
            backgroundColor: 'rgba(0,0,0,0.2)',
            borderRadius: '8px',
        },
        path: {
            fill: 'none',
            strokeWidth: 2,
            strokeLinejoin: 'round',
            strokeLinecap: 'round',
        },
        legend: {
            display: 'flex',
            justifyContent: 'center',
            gap: '1rem',
            marginTop: '0.5rem',
            fontSize: '0.8rem'
        },
        legendItem: {
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
        }
    };

    return (
        <div style={styles.chartContainer}>
            <svg viewBox={`0 0 ${width} ${height}`} style={styles.svg} aria-label="Stock price chart">
                <path d={pricePath} style={{...styles.path, stroke: '#888888'}} />
                <path d={smaLongPath} style={{...styles.path, stroke: 'var(--neutral-color)'}} />
                <path d={smaShortPath} style={{...styles.path, stroke: 'var(--primary-color)'}} />
                {crossoverX !== null && crossoverY !== null && (
                    <circle cx={crossoverX} cy={crossoverY} r="5" fill="white" stroke="black" strokeWidth="1.5" />
                )}
            </svg>
            <div style={styles.legend}>
                <div style={styles.legendItem}>
                    <div style={legendColorBox('#888888')}></div>
                    <span>Price</span>
                </div>
                <div style={styles.legendItem}>
                    <div style={legendColorBox('var(--primary-color)')}></div>
                    <span>{shortPeriod}-Day MA</span>
                </div>
                <div style={styles.legendItem}>
                    <div style={legendColorBox('var(--neutral-color)')}></div>
                    <span>{longPeriod}-Day MA</span>
                </div>
            </div>
        </div>
    );
};

const SignalDisplay = ({ result }: { result: SignalResult }) => {
    const { signal, symbol, companyName, exchange, latestPrice, distancePercent, news, ratings, sentimentSummary, earningsDate } = result;
    const signalConfig = {
        up: { icon: '👍', color: 'var(--success-color)', text: 'Bullish Signal' },
        down: { icon: '👎', color: 'var(--danger-color)', text: 'Bearish Signal' },
        neutral: { icon: '✋', color: 'var(--neutral-color)', text: 'Neutral Signal' }
    };

    const getDaysUntil = (dateString: string) => {
        if (!dateString || typeof dateString !== 'string') return null;
        
        const datePart = dateString.split(' ')[0];
        const earningsDate = new Date(datePart);
        // Normalize to UTC noon to avoid timezone-related "off-by-one-day" errors
        earningsDate.setUTCHours(12, 0, 0, 0);
    
        const today = new Date();
        today.setUTCHours(12, 0, 0, 0);
    
        if (isNaN(earningsDate.getTime())) return null; // Invalid date
    
        if (earningsDate < today) return null; // Date is in the past
    
        const diffTime = earningsDate.getTime() - today.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        
        if (diffDays === 0) return '(Today)';
        if (diffDays === 1) return '(Tomorrow)';
    
        return `(in ${diffDays} days)`;
    };

    const daysUntilEarnings = getDaysUntil(earningsDate);
    const config = signalConfig[signal];
    const formattedDistance = `${distancePercent > 0 ? '+' : ''}${distancePercent.toFixed(2)}%`;

    const styles: { [key: string]: React.CSSProperties } = {
        card: {
            backgroundColor: 'var(--input-bg-color)',
            padding: '2rem',
            borderRadius: '12px',
            border: `1px solid ${config.color}`,
            boxShadow: `0 0 20px -5px ${config.color}`,
            animation: 'fadeIn 0.5s'
        },
        icon: {
            fontSize: '6rem',
            lineHeight: 1,
            marginBottom: '1rem',
            textShadow: `0 0 15px ${config.color}`
        },
        header: {
            color: config.color,
            fontSize: '1.5rem',
            fontWeight: 700,
            margin: '0 0 0.5rem 0'
        },
        subHeader: {
            fontSize: '1.25rem',
            fontWeight: 500,
            margin: '0 0 1.5rem 0'
        },
        infoGrid: {
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '1rem',
            textAlign: 'left',
        },
        infoItem: {
            backgroundColor: 'rgba(0,0,0,0.2)',
            padding: '0.75rem',
            borderRadius: '8px',
        },
        infoLabel: {
            display: 'block',
            fontSize: '0.8rem',
            color: '#AAAAAA',
            marginBottom: '0.25rem'
        },
        infoValue: {
            fontSize: '1.1rem',
            fontWeight: 500
        },
        intelSection: {
            marginTop: '2rem',
            paddingTop: '1.5rem',
            borderTop: '1px solid var(--border-color)',
            textAlign: 'left'
        },
        sentimentSection: {
            marginTop: '1.5rem',
            paddingTop: '1.5rem',
            borderTop: '1px solid var(--border-color)',
            textAlign: 'left'
        },
        intelHeader: {
            fontSize: '1rem',
            fontWeight: 700,
            color: 'var(--primary-color)',
            marginBottom: '1rem'
        },
        intelList: {
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
            fontSize: '0.9rem',
        },
        intelItem: {
            backgroundColor: 'rgba(0,0,0,0.2)',
            padding: '0.75rem',
            borderRadius: '8px',
        },
        newsSource: {
            fontSize: '0.8rem',
            color: '#888',
            marginLeft: '0.5rem',
        }
    };

    return (
        <div style={styles.card}>
            <div style={styles.icon}>{config.icon}</div>
            <h2 style={styles.header}>{config.text}</h2>
            <h3 style={styles.subHeader}>{companyName} ({symbol})</h3>
            <div style={styles.infoGrid}>
                <div style={styles.infoItem}>
                    <span style={styles.infoLabel}>Exchange</span>
                    <span style={styles.infoValue}>{exchange}</span>
                </div>
                <div style={styles.infoItem}>
                    <span style={styles.infoLabel}>Latest Price (Real-Time)</span>
                    <span style={styles.infoValue}>${latestPrice.toFixed(2)}</span>
                </div>
                <div style={styles.infoItem}>
                    <span style={styles.infoLabel}>Crossover Price</span>
                    <span style={styles.infoValue}>${result.crossoverPrice.toFixed(2)}</span>
                </div>
                <div style={styles.infoItem}>
                    <span style={styles.infoLabel}>Distance from Crossover</span>
                    <span style={{ ...styles.infoValue, color: distancePercent >= 0 ? 'var(--success-color)' : 'var(--danger-color)' }}>
                        {formattedDistance}
                    </span>
                </div>
                 {earningsDate && (
                    <div style={{...styles.infoItem, gridColumn: '1 / -1'}}>
                        <span style={styles.infoLabel}>Next Earnings Date</span>
                        <span style={styles.infoValue}>
                            {earningsDate}
                            {daysUntilEarnings && (
                                <span style={{color: '#AAAAAA', marginLeft: '0.5rem', fontWeight: 400}}>
                                    {daysUntilEarnings}
                                </span>
                            )}
                        </span>
                    </div>
                )}
            </div>
             <Chart
                prices={result.prices}
                smaShort={result.smaShort}
                smaLong={result.smaLong}
                crossoverIndex={result.crossoverIndex}
                shortPeriod={result.shortPeriod}
                longPeriod={result.longPeriod}
            />
             {(news?.length > 0 || ratings?.length > 0) && (
                <div style={styles.intelSection}>
                    <h4 style={styles.intelHeader}>Latest Intelligence</h4>
                    {news?.length > 0 && (
                        <div>
                            <ul style={styles.intelList}>
                                {news.map((item, index) => (
                                    <li key={index} style={styles.intelItem}>
                                        {item.title}
                                        <span style={styles.newsSource}>({item.source})</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {ratings?.length > 0 && (
                         <div style={{ marginTop: news?.length > 0 ? '1rem' : '0' }}>
                            <ul style={styles.intelList}>
                                {ratings.map((item, index) => (
                                    <li key={index} style={styles.intelItem}>{item}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            )}
             {sentimentSummary && (
                <div style={styles.sentimentSection}>
                    <h4 style={styles.intelHeader}>X.com Sentiment Analysis</h4>
                    <div style={styles.intelItem}>
                       {sentimentSummary}
                    </div>
                </div>
            )}
        </div>
    );
};

const App = ({ apiKey }: { apiKey: string }) => {
    const [symbol, setSymbol] = useState('');
    const [shortPeriod, setShortPeriod] = useState('10');
    const [longPeriod, setLongPeriod] = useState('20');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<SignalResult | null>(null);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const short = parseInt(shortPeriod, 10);
        const long = parseInt(longPeriod, 10);

        if (!symbol.trim() || isLoading) return;
        if (isNaN(short) || isNaN(long) || short <= 0 || long <= 0) {
            setError("MA periods must be positive numbers.");
            return;
        }
        if (short >= long) {
            setError("Short-term period must be less than long-term period.");
            return;
        }

        setIsLoading(true);
        setError(null);
        setResult(null);

        try {
            const data = await getStockData(symbol.trim().toUpperCase(), apiKey);
            if (data) {
                const analysisResult = analyzeData(symbol, data, short, long);
                setResult(analysisResult);
            }
        } catch (err: any) {
            setError(err.message || 'An unexpected error occurred.');
        } finally {
            setIsLoading(false);
        }
    };

    const styles: { [key: string]: React.CSSProperties } = {
        title: {
            fontSize: '2rem',
            fontWeight: 700,
            color: 'var(--primary-color)',
            marginBottom: '0.25rem',
            textShadow: '0 0 5px rgba(74, 144, 226, 0.5)'
        },
        subtitle: {
            fontSize: '1rem',
            color: '#888',
            margin: '0 0 2rem 0',
            lineHeight: 1.4,
        },
        form: {
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
            marginBottom: '2rem'
        },
        inputGroup: {
            display: 'flex',
            gap: '0.5rem',
        },
         periodInputs: {
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '0.5rem',
        },
        input: {
            flex: 1,
            padding: '0.75rem 1rem',
            fontSize: '1rem',
            backgroundColor: 'var(--input-bg-color)',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            color: 'var(--text-color)',
            outline: 'none',
            transition: 'border-color 0.2s, box-shadow 0.2s',
            boxSizing: 'border-box',
            width: '100%',
        },
        button: {
            padding: '0.75rem 1.5rem',
            fontSize: '1rem',
            fontWeight: 500,
            backgroundColor: 'var(--primary-color)',
            color: '#FFFFFF',
            border: 'none',
            borderRadius: '8px',
            cursor: 'pointer',
            transition: 'background-color 0.2s, transform 0.2s'
        },
        loader: {
            fontSize: '1rem'
        },
        error: {
            color: 'var(--danger-color)',
            backgroundColor: 'rgba(220, 53, 69, 0.1)',
            padding: '1rem',
            borderRadius: '8px',
            border: '1px solid var(--danger-color)',
        }
    };
    
    return (
        <div className="container">
            <header>
                <h1 style={styles.title}>MA Crossover Signal</h1>
                <p style={styles.subtitle}>
                    Customizable Moving Average Indicator
                    <br />
                    <span style={{fontSize: '0.8rem', color: '#666'}}>
                        Latest price, news & sentiment via Google Search. Historical data is simulated.
                    </span>
                </p>
            </header>
            <form onSubmit={handleSubmit} style={styles.form}>
                 <div style={styles.inputGroup}>
                     <input
                        type="text"
                        value={symbol}
                        onChange={(e) => setSymbol(e.target.value)}
                        placeholder="Enter US stock symbol (e.g., AAPL)"
                        style={styles.input}
                        aria-label="Stock Symbol"
                        disabled={isLoading}
                    />
                </div>
                <div style={styles.periodInputs}>
                     <input
                        type="number"
                        value={shortPeriod}
                        onChange={(e) => setShortPeriod(e.target.value)}
                        placeholder="Short MA"
                        style={styles.input}
                        aria-label="Short-term Moving Average Period"
                        disabled={isLoading}
                        min="1"
                    />
                     <input
                        type="number"
                        value={longPeriod}
                        onChange={(e) => setLongPeriod(e.target.value)}
                        placeholder="Long MA"
                        style={styles.input}
                        aria-label="Long-term Moving Average Period"
                        disabled={isLoading}
                        min="2"
                    />
                </div>
                <button type="submit" style={styles.button} disabled={isLoading}>
                    {isLoading ? 'Analyzing...' : 'Get Signal'}
                </button>
            </form>
            <main>
                {isLoading && <p style={styles.loader}>Fetching and analyzing data...</p>}
                {error && <div style={styles.error}>{error}</div>}
                {result && <SignalDisplay result={result} />}
            </main>
        </div>
    );
};


const ApiKeyPrompt = ({ onApiKeySubmit }: { onApiKeySubmit: (key: string) => void }) => {
    const [apiKey, setApiKey] = useState('');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (apiKey.trim()) {
            onApiKeySubmit(apiKey.trim());
        }
    };

    const styles: { [key: string]: React.CSSProperties } = {
        container: {
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
            animation: 'fadeIn 0.5s ease-in-out',
            padding: '2.5rem',
            backgroundColor: 'var(--input-bg-color)',
            borderRadius: '12px',
            border: '1px solid var(--border-color)',
            textAlign: 'left'
        },
        title: {
            fontSize: '1.5rem',
            fontWeight: 700,
            color: 'var(--primary-color)',
            margin: 0,
        },
        p: {
            color: '#AAAAAA',
            margin: '0.5rem 0 0 0',
            lineHeight: 1.5,
        },
        form: {
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
            marginTop: '1rem',
        },
        input: {
            padding: '0.75rem 1rem',
            fontSize: '1rem',
            backgroundColor: '#0a0a0a',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            color: 'var(--text-color)',
            outline: 'none',
            transition: 'border-color 0.2s, box-shadow 0.2s',
        },
        button: {
            padding: '0.75rem 1.5rem',
            fontSize: '1rem',
            fontWeight: 500,
            backgroundColor: 'var(--primary-color)',
            color: '#FFFFFF',
            border: 'none',
            borderRadius: '8px',
            cursor: 'pointer',
            transition: 'background-color 0.2s, transform 0.2s'
        },
        link: {
            color: 'var(--primary-color)',
            textDecoration: 'none',
            fontWeight: 500,
        },
        guide: {
            marginTop: '1.5rem',
            paddingTop: '1.5rem',
            borderTop: '1px solid var(--border-color)',
        },
        guideTitle: {
             fontSize: '1rem',
             fontWeight: 700,
             color: 'var(--text-color)',
             margin: '0 0 1rem 0',
        },
        steps: {
            listStylePosition: 'inside',
            padding: 0,
            margin: 0,
            color: '#AAAAAA',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem'
        }
    };

    return (
        <div style={styles.container}>
            <h1 style={styles.title}>Welcome! One Quick Step</h1>
            <p style={styles.p}>
                This app uses the Google Gemini API to get live data. To protect the developer from costs, you'll need your own free API key to use it.
            </p>
             <p style={styles.p}>
                Your key is saved only in this browser and is never shared.
            </p>
            <form onSubmit={handleSubmit} style={styles.form}>
                <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Enter your Gemini API Key"
                    style={styles.input}
                    aria-label="Gemini API Key"
                />
                <button type="submit" style={styles.button}>
                    Save and Start Analyzing
                </button>
            </form>

            <div style={styles.guide}>
                <h2 style={styles.guideTitle}>How to Get Your Free Key (in 30 seconds)</h2>
                <ol style={styles.steps}>
                    <li>
                        Go to {' '}
                        <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" style={styles.link}>
                             Google AI Studio
                        </a>.
                    </li>
                    <li>Click <strong>"Create API key in new project"</strong>.</li>
                    <li>Copy the key that appears and paste it above. That's it!</li>
                </ol>
            </div>
        </div>
    );
};

const AppWrapper = () => {
    const [apiKey, setApiKey] = useState<string | null>(() => sessionStorage.getItem('GEMINI_API_KEY'));

    const handleApiKeySubmit = (key: string) => {
        sessionStorage.setItem('GEMINI_API_KEY', key);
        setApiKey(key);
    };

    if (!apiKey) {
        return <ApiKeyPrompt onApiKeySubmit={handleApiKeySubmit} />;
    }

    return <App apiKey={apiKey} />;
};


const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(<AppWrapper />);
